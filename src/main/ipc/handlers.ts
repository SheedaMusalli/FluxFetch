import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import {
  clipboard,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell,
  BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { IpcContract } from '../../shared/ipc-contract'
import type { InitialState, StartDownloadRequest, ThemeSource } from '../../shared/types'
import { DownloadManager } from '../download/downloadManager'
import { getDefaultDownloadsDir, getHomeDir } from '../download/paths'
import { probeUrl } from '../download/probe'
import { deviceBindingSupported } from '../network/deviceBinding'
import { measureLatencies } from '../network/latency'
import { createNetworkSpeedConnection, measureNetworkSpeedSample } from '../network/speedTest'
import type { StreamConnection } from '../network/routes'
import { NetworkMonitor } from '../network/interfaces'
import { loadSettings, saveSettings } from '../settings'
import { testKnobs } from '../testKnobs'
import { checkForUpdate, UPDATE_PAGE_URL } from '../updateCheck'
import { TorrentManager } from '../torrent/libtorrent'
import { createTransferSummary } from '../../shared/transfers'
import { extractArchiveEntries, previewArchive } from '../archive'
import { listSiteAuthOrigins, removeSiteAuth, saveSiteAuth, siteAuthContext } from '../siteAuth'
import {
  remoteAccessInfo,
  restartRemoteManagement,
  saveRemoteCredentials
} from '../remoteManagement'
import { displayProxyAddress, loadProxyUrl, saveProxyConfig } from '../proxySettings'
import { presentWindow } from '../windowActivation'

async function openNetworkSettings(): Promise<void> {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:network-status')
  } else if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.network')
  } else if (process.platform === 'linux') {
    try {
      const { exec } = await import('node:child_process')
      exec('gnome-control-center network || nm-connection-editor || true')
    } catch {
      // Best-effort
    }
  }
}

function runSystemAction(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true }, (error) =>
      error ? reject(error) : resolve()
    )
  })
}

async function runPostDownloadAction(action: 'close' | 'sleep' | 'shutdown'): Promise<void> {
  if (action === 'close') {
    app.quit()
    return
  }
  if (process.platform === 'win32') {
    if (action === 'sleep') {
      await runSystemAction('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
    } else {
      await runSystemAction('shutdown.exe', ['/s', '/t', '60'])
    }
  } else if (process.platform === 'darwin') {
    await runSystemAction(
      action === 'sleep' ? 'pmset' : 'osascript',
      action === 'sleep' ? ['sleepnow'] : ['-e', 'tell app "System Events" to shut down']
    )
  } else {
    await runSystemAction(
      action === 'sleep' ? 'systemctl' : 'shutdown',
      action === 'sleep' ? ['suspend'] : ['-h', '+1']
    )
  }
}

/** Typed wrapper around ipcMain.handle — the channel name picks its args/result shape out of
 * IpcContract, so a handler here that doesn't match what fluxfetchApi (preload) actually calls is a
 * compile error instead of a silent runtime mismatch. */
function handle<K extends keyof IpcContract>(
  channel: K,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: IpcContract[K]['args']
  ) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>
): void {
  ipcMain.handle(
    IpcChannels[channel],
    listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  )
}

const DESTINATION_CHECK_MS = 300

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  getWindows: () => BrowserWindow[],
  openDownloadWindow: (downloadId: string) => void,
  torrents: TorrentManager
): DownloadManager {
  const speedTestConnections = new Map<
    string,
    { connection: StreamConnection; signature: string }
  >()
  // The main process keeps the network list, for downloads and the window alike.
  const networks = new NetworkMonitor((list) => {
    const activeNetworks = new Map(list.map((network) => [network.id, network]))
    for (const [id, entry] of speedTestConnections) {
      const network = activeNetworks.get(id)
      if (!network) {
        entry.connection.close()
        speedTestConnections.delete(id)
      } else {
        const signature = JSON.stringify(network)
        if (signature !== entry.signature) {
          entry.connection.reconnect()
          entry.signature = signature
        }
      }
    }
    manager.networksChanged()
    for (const window of getWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.networksChanged, list)
    }
  })
  const manager = new DownloadManager(
    getWindow,
    networks,
    getWindows,
    openDownloadWindow,
    (downloadId) => {
      void (async () => {
        const download = await manager.getDownload(downloadId)
        if (!download || download.state.status !== 'completed') return
        if ((await manager.getQueuedDownloads()).length > 0) return
        const action = (await loadSettings()).postDownloadAction ?? 'none'
        if (action === 'none') return
        try {
          await runPostDownloadAction(action)
        } catch (error) {
          console.error('[post-download-action]', error)
        }
      })()
    }
  )
  let lastClipboard = ''
  void clipboard.readText().then((value) => (lastClipboard = value.trim()))
  let clipboardPromptActive = false
  const clipboardTimer = setInterval(() => {
    void (async () => {
      const text = (await clipboard.readText()).trim()
      if (text === lastClipboard) return
      lastClipboard = text
      if (clipboardPromptActive || !text || text.length > 32768) return
      const settings = await loadSettings()
      if (!settings.clipboardMonitoring) return
      let parsed: URL
      try {
        parsed = new URL(text)
      } catch {
        return
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        return
      clipboardPromptActive = true
      try {
        const window = getWindow()
        if (!window || window.isDestroyed()) return
        presentWindow(window)
        const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || 'download')
        const confirmation = await manager.confirmExternalDownload(
          fileName,
          `Copied link · ${parsed.origin}`
        )
        if (!confirmation.accepted) return
        const current = await manager.getCurrentDownload()
        if (current && ['downloading', 'paused', 'error'].includes(current.state.status)) {
          await manager.queueDownloads(
            [parsed.href],
            confirmation.destinationDir || settings.destinationDir || app.getPath('downloads'),
            null
          )
          return
        }
        const probe = await probeUrl(parsed.href, undefined, settings.customUserAgent)
        if (/text\/html|application\/xhtml/i.test(probe.contentType ?? ''))
          throw new Error('The copied link opens a web page, not a direct download.')
        const active = await networks.refresh()
        const request: StartDownloadRequest = {
          url: probe.finalUrl,
          sourcePageUrl: undefined,
          destinationDir:
            confirmation.destinationDir || settings.destinationDir || app.getPath('downloads'),
          temporaryDir: confirmation.temporaryDir,
          suggestedFileName: probe.suggestedFileName || fileName,
          totalBytes: probe.totalBytes ?? 0,
          supportsRanges: probe.supportsRanges,
          interfaceIds: active.map((network) => network.id),
          etag: probe.etag,
          lastModified: probe.lastModified
        }
        await manager.start(request)
      } catch (error) {
        console.error('[clipboard-download]', error)
        const window = getWindow()
        if (window && !window.isDestroyed()) {
          window.webContents.send(IpcChannels.prepareRetry, parsed.href)
        }
      } finally {
        clipboardPromptActive = false
      }
    })().catch((error) => console.error('[clipboard-monitor]', error))
  }, 1000)
  clipboardTimer.unref()
  const speedTestSamples = new Map<string, AbortController>()
  handle('minimizeToTray', () => {
    const window = getWindow()
    if (process.platform === 'win32' && window && !window.isDestroyed()) window.hide()
  })
  const senderWindow = (event: IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)
  handle('windowMinimize', (event) => senderWindow(event)?.minimize())
  handle('windowToggleMaximize', (event) => {
    const window = senderWindow(event)
    if (window && !window.isDestroyed()) {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    }
  })
  handle('windowClose', (event) => senderWindow(event)?.close())
  handle('windowIsMaximized', (event) => senderWindow(event)?.isMaximized() ?? false)
  // Waking from sleep, the networks may have changed without a poll in between to see it.
  powerMonitor.on('resume', () => {
    manager.systemResumed()
    void networks.refresh()
  })

  handle('listInterfaces', () => networks.refresh())

  handle('pingInterfaces', async () => measureLatencies(networks.current ?? []))

  handle('measureNetworkSpeedSample', async (_event, requestId, networkId, direction, bytes) => {
    if (!/^[\w:-]{1,100}$/.test(requestId) || speedTestSamples.has(requestId)) {
      throw new Error('The speed-test request is invalid.')
    }
    const network = networks.find(networkId)
    if (!network) throw new Error('That network is no longer connected.')
    const controller = new AbortController()
    speedTestSamples.set(requestId, controller)
    let entry = speedTestConnections.get(networkId)
    if (!entry) {
      entry = {
        connection: createNetworkSpeedConnection(() => networks.find(networkId)),
        signature: JSON.stringify(network)
      }
      speedTestConnections.set(networkId, entry)
    }
    try {
      return await measureNetworkSpeedSample(network, direction, bytes, controller.signal, {
        connection: entry.connection
      })
    } finally {
      speedTestSamples.delete(requestId)
    }
  })

  handle('cancelNetworkSpeedSample', (_event, requestId) => {
    speedTestSamples.get(requestId)?.abort()
  })

  // Started now so it has settled before the first ping or download needs it.
  const bindingSupport = deviceBindingSupported()
  handle('deviceBindingSupported', async () => bindingSupport)

  // The app only ever assigns 'light'/'dark' to nativeTheme.themeSource (main/index.ts's startup
  // call to loadThemeSource() never resolves to 'system') — narrow Electron's wider type here
  // rather than widening our own ThemeSource just to match it.
  const currentThemeSource = (): ThemeSource =>
    nativeTheme.themeSource === 'dark' ? 'dark' : 'light'

  handle('updateSettings', async (_event, patch) => {
    // The one setting main also applies — before saving, so a failed write still switches the
    // window to the theme the toggle now shows.
    if (patch?.themeSource === 'light' || patch?.themeSource === 'dark') {
      nativeTheme.themeSource = patch.themeSource
    }
    await saveSettings(patch)
    if (patch?.remoteManagement) await restartRemoteManagement(manager)
  })

  // Answered via sendSync from the preload, which blocks the page until returnValue is set — so a
  // throw here must still reply (with no saved values) rather than leave the window never showing.
  ipcMain.on(IpcChannels.getInitialState, async (event) => {
    try {
      const settings = await loadSettings()
      const { destinationDir } = settings
      // Capped: a folder on a dropped network share can take many seconds to answer, and launch
      // waits on this reply — past the cap it's treated as gone and Downloads is used instead.
      const destinationExists =
        destinationDir !== undefined &&
        (await Promise.race([
          stat(destinationDir).then(
            (stats) => stats.isDirectory(),
            () => false
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, DESTINATION_CHECK_MS, false))
        ]))
      event.returnValue = {
        homeDir: getHomeDir(),
        downloadsDir: getDefaultDownloadsDir(),
        themeSource: currentThemeSource(),
        networkPreferences: settings.networkPreferences ?? {},
        destinationDir: destinationExists ? destinationDir : undefined,
        maxDownloadSpeedBytesPerSec: settings.maxDownloadSpeedBytesPerSec ?? 0,
        clipboardMonitoring: settings.clipboardMonitoring ?? false,
        proxyEnabled: settings.proxyEnabled ?? false,
        customUserAgent: settings.customUserAgent ?? '',
        postDownloadAction: settings.postDownloadAction ?? 'none',
        remoteManagement: settings.remoteManagement ?? { enabled: false, port: 8787, username: '' }
      } satisfies InitialState
    } catch (error) {
      console.error('[fluxfetch] failed to read initial state', error)
      // No getPath() here — it may be what threw. An empty destination just keeps Start disabled.
      event.returnValue = {
        homeDir: '',
        downloadsDir: '',
        themeSource: currentThemeSource(),
        networkPreferences: {},
        maxDownloadSpeedBytesPerSec: 0,
        clipboardMonitoring: false,
        proxyEnabled: false,
        customUserAgent: '',
        postDownloadAction: 'none',
        remoteManagement: { enabled: false, port: 8787, username: '' }
      } satisfies InitialState
    }
  })

  handle('openNetworkSettings', async () => {
    await openNetworkSettings()
  })

  handle('probeUrl', async (_event, url, userAgent) =>
    probeUrl(url, await siteAuthContext(url), userAgent)
  )

  handle('chooseDestinationFolder', async (_event, defaultPath) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('readClipboardText', async () => clipboard.readText())

  handle('revealInFolder', async (_event, filePath) => {
    shell.showItemInFolder(filePath)
  })

  handle('openFile', async (_event, filePath) => {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('The download file is not available.')
    const error = await shell.openPath(filePath)
    if (error) throw new Error(error)
  })

  handle('trashFile', async (_event, filePath) => {
    if (!isAbsolute(filePath)) throw new Error('The download file path is invalid.')
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('The download file is not available.')
    await shell.trashItem(filePath)
  })

  handle('runOmniLink', async () => {
    if (process.platform !== 'win32') {
      throw new Error('OmniLink is available on Windows only.')
    }
    const resourceDirectory = app.isPackaged
      ? join(process.resourcesPath, 'omnilink')
      : join(app.getAppPath(), 'resources', 'omnilink')
    const executable = join(resourceDirectory, 'omnilink-tray.exe')
    const executableInfo = await stat(executable).catch(() => null)
    const runtimeInfo = await stat(join(resourceDirectory, 'WinDivert.dll')).catch(() => null)
    const driverInfo = await stat(join(resourceDirectory, 'WinDivert64.sys')).catch(() => null)
    if (!executableInfo?.isFile() || !runtimeInfo?.isFile() || !driverInfo?.isFile()) {
      throw new Error('OmniLink is not installed with FluxFetch. Rebuild the Windows package.')
    }
    const escapedPath = executable.replace(/'/g, "''")
    await runSystemAction('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$running = Get-Process -Name 'omnilink-tray' -ErrorAction SilentlyContinue; if (-not $running) { Start-Process -FilePath '${escapedPath}' -Verb RunAs -WindowStyle Hidden }`
    ])
  })

  handle('previewZip', async (_event, filePath) => previewArchive(filePath))
  handle('extractZipEntries', async (_event, filePath, entries, destination) =>
    extractArchiveEntries(filePath, entries, destination)
  )

  handle('openExternalUrl', async (_event, rawUrl) => {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new Error('That page address is invalid.')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Only HTTP and HTTPS pages can be opened.')
    }
    await shell.openExternal(url.href)
  })

  const addTorrentAfterConfirmation = async (
    source: string,
    fileName: string,
    localFile = false
  ): Promise<boolean> => {
    const settings = await loadSettings()
    const window = getWindow()
    if (!window || window.isDestroyed()) throw new Error('The FluxFetch window is not available.')
    const confirmation = await manager.confirmExternalDownload(
      fileName,
      `BitTorrent · ${source.startsWith('magnet:') ? 'magnet link' : fileName}`
    )
    if (!confirmation.accepted) return false
    const baseDir =
      confirmation.destinationDir || settings.destinationDir || app.getPath('downloads')
    const destinationDir = baseDir
    if (localFile)
      await torrents.addFile(source, destinationDir, settings.maxDownloadSpeedBytesPerSec ?? 0)
    else await torrents.add(source, destinationDir, settings.maxDownloadSpeedBytesPerSec ?? 0)
    return true
  }
  handle('addTorrent', async (_event, source) => {
    if (typeof source !== 'string' || source.length > 16_384)
      throw new Error('That torrent source is invalid.')
    let fileName = 'Torrent download'
    if (source.startsWith('magnet:')) {
      try {
        fileName = new URL(source).searchParams.get('dn') || fileName
      } catch {
        /* validated by engine */
      }
    } else {
      try {
        fileName = decodeURIComponent(new URL(source).pathname.split('/').pop() || fileName)
      } catch {
        /* validated by engine */
      }
    }
    return addTorrentAfterConfirmation(source, fileName.slice(0, 240))
  })
  handle('chooseTorrentFile', async () => {
    const window = getWindow()
    if (!window || window.isDestroyed()) throw new Error('The FluxFetch window is not available.')
    const result = await dialog.showOpenDialog(window, {
      title: 'Open torrent file',
      properties: ['openFile'],
      filters: [{ name: 'BitTorrent files', extensions: ['torrent'] }]
    })
    if (result.canceled || !result.filePaths[0]) return false
    return addTorrentAfterConfirmation(
      result.filePaths[0],
      result.filePaths[0].split(/[\\/]/).pop() || 'Torrent download',
      true
    )
  })
  handle('listTorrents', async () => torrents.list())
  handle('getTransferSummary', async () =>
    createTransferSummary(await manager.listTransferProgress(), torrents.getProgressSnapshot())
  )
  handle('pauseTorrent', async (_event, gid) => torrents.pause(gid))
  handle('resumeTorrent', async (_event, gid) => torrents.resume(gid))
  handle('reannounceTorrent', async (_event, gid) => torrents.reannounce(gid))
  handle('openTorrentFolder', async (_event, gid) => torrents.openFolder(gid))
  handle('removeTorrent', async (_event, gid, deleteFiles) => torrents.remove(gid, deleteFiles))
  handle('listSiteAuthOrigins', async () => listSiteAuthOrigins())
  handle('saveSiteAuth', async (_event, input) => saveSiteAuth(input.origin, input))
  handle('removeSiteAuth', async (_event, origin) => removeSiteAuth(origin))
  handle('saveRemoteCredentials', async (_event, username, password) => {
    await saveRemoteCredentials(username, password)
  })
  handle('remoteAccessInfo', async () => remoteAccessInfo())
  handle('saveProxyConfig', async (_event, server, username, password) => {
    await saveProxyConfig(server, username, password)
    const proxyUrl = await loadProxyUrl()
    await saveSettings({ proxyEnabled: Boolean(proxyUrl) })
  })
  handle('proxyConfigInfo', async () => {
    const proxyUrl = await loadProxyUrl()
    return { server: displayProxyAddress(proxyUrl), enabled: Boolean(proxyUrl) }
  })

  handle('respondDownloadConfirmation', (event, requestId, accepted) => {
    const window = getWindow()
    if (!window || event.sender !== window.webContents) {
      throw new Error('Download confirmation came from an untrusted renderer.')
    }
    if (
      !accepted ||
      typeof accepted.accepted !== 'boolean' ||
      (accepted.destinationDir !== undefined &&
        (typeof accepted.destinationDir !== 'string' || !isAbsolute(accepted.destinationDir))) ||
      (accepted.temporaryDir !== undefined &&
        (typeof accepted.temporaryDir !== 'string' || !isAbsolute(accepted.temporaryDir)))
    ) {
      throw new Error('The download location selection is invalid.')
    }
    manager.resolveDownloadConfirmation(requestId, accepted)
  })

  handle('getQueuedDownloads', async () => manager.getQueuedDownloads())

  handle('queueDownloads', async (_event, urls, destinationDir, scheduledAt) =>
    manager.queueDownloads(urls, destinationDir, scheduledAt)
  )

  handle('cancelQueuedDownload', async (_event, id) => manager.cancelQueuedDownload(id))

  handle('startDownload', async (_event, request) => manager.start(request))

  handle('getCurrentDownload', async () => manager.getCurrentDownload())

  handle('getDownload', async (_event, id) => manager.getDownload(id))

  handle('openDownloadWindow', async (_event, id) => {
    const download = await manager.getDownload(id)
    if (!download) throw new Error('That download window is unavailable.')
    openDownloadWindow(id)
  })

  handle('showMainWindow', (event, retryUrl) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      presentWindow(window)
      if (retryUrl !== undefined) {
        let parsed: URL
        try {
          parsed = new URL(retryUrl)
        } catch {
          throw new Error('That download address is invalid.')
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('That download address is invalid.')
        }
        window.webContents.send(IpcChannels.prepareRetry, parsed.toString())
      }
    }
    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    if (senderWindow && senderWindow !== window && !senderWindow.isDestroyed()) senderWindow.close()
  })

  handle('pauseDownload', async (_event, id) => {
    await manager.pause(id)
  })

  handle('resumeDownload', async (_event, id) => {
    manager.resume(id)
  })

  handle('setDownloadNetwork', async (_event, id, networkId, enabled) => {
    await manager.setNetworkEnabled(id, networkId, enabled)
  })

  handle('cancelDownload', async (_event, id) => manager.cancel(id))

  handle('removeDownload', async (_event, id) => manager.remove(id))

  // Dismissal is read per call, not cached with the check — a reload after "Not now" must not
  // bring the dialog back.
  handle('checkForUpdate', async () => {
    const info = testKnobs.forceUpdateVersion
      ? { version: testKnobs.forceUpdateVersion, url: UPDATE_PAGE_URL }
      : await checkForUpdate(app.getVersion())
    if (!info) return null
    const { dismissedUpdateVersion } = await loadSettings()
    return { ...info, dismissed: info.version === dismissedUpdateVersion }
  })

  return manager
}
