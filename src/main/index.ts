import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog, nativeTheme, shell, Tray, Menu } from 'electron'
import { join, basename, isAbsolute } from 'path'
import { existsSync, renameSync } from 'node:fs'
import { legacyDataFolder } from '../shared/legacyIdentity'
import icon from '../../resources/icon-dark.png?asset'
import windowsIcon from '../../resources/icon.ico?asset'
import { registerIpcHandlers } from './ipc/handlers'
import { IpcChannels } from '../shared/ipc-channels'
import { createTransferSummary, transferTrayTooltip } from '../shared/transfers'
import { loadSettings, loadThemeSource, migrateLegacyNetworkPreferences } from './settings'
import { testKnobs } from './testKnobs'
import type { DownloadManager } from './download/downloadManager'

import { startBrowserBridge } from './browser/bridge'
import { restartRemoteManagement, stopRemoteManagement } from './remoteManagement'
import { presentWindow } from './windowActivation'
import { TorrentManager } from './torrent/libtorrent'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
// Keep existing settings, history, recovery state, and queued links after the visible rebrand.
const dataFolder = join(app.getPath('appData'), 'FluxFetch')
const previousDataFolder = join(app.getPath('appData'), legacyDataFolder)
if (!testKnobs.userDataDir && !existsSync(dataFolder) && existsSync(previousDataFolder)) {
  // Move the complete profile, including encrypted recovery records, without overwriting a
  // profile already created by this version. Do not recreate the old directory on failure.
  try {
    renameSync(previousDataFolder, dataFolder)
  } catch (error) {
    console.warn('Could not migrate the previous app profile.', error)
  }
}
app.setPath('userData', dataFolder)
app.setName('FluxFetch')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

let mainWindow: BrowserWindow | null = null
let windowsInitialized = false
const downloadWindows = new Map<string, BrowserWindow>()
let downloadManager: DownloadManager | null = null
let quitAfterSuspending = false
let tray: Tray | null = null
let transferStatusTimer: NodeJS.Timeout | null = null
let browserBridge: import('node:net').Server | null = null
let torrentManager: TorrentManager | null = null
let quitting = false
let finishProtocolInitialization!: () => void
const protocolInitialization = new Promise<void>((resolve) => {
  finishProtocolInitialization = resolve
})
let protocolLinkQueue = Promise.resolve()
const primary = testKnobs.userDataDir ? true : app.requestSingleInstanceLock()
if (!primary) app.quit()
function showWindow(): void {
  if (testKnobs.hideWindow) return
  if (!mainWindow) createWindow()
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  presentWindow(window)
}
app.on('second-instance', (_event, commandLine) => {
  if (windowsInitialized) showWindow()
  handleProtocolArguments(commandLine)
})

function handleProtocolArguments(args: readonly string[]): void {
  const links = args.filter(
    (arg) =>
      arg.length <= 16_384 &&
      (/^magnet:/i.test(arg) || (isAbsolute(arg) && /\.torrent$/i.test(arg)))
  )
  for (const rawLink of links) {
    protocolLinkQueue = protocolLinkQueue
      .then(async () => {
        await protocolInitialization
        if (isAbsolute(rawLink) && /\.torrent$/i.test(rawLink)) {
          if (!downloadManager || !torrentManager)
            throw new Error('Torrent support is not ready yet.')
          showWindow()
          const confirmation = await downloadManager.confirmExternalDownload(
            basename(rawLink),
            'BitTorrent · torrent file'
          )
          if (!confirmation.accepted) return
          const settings = await loadSettings()
          await torrentManager.addFile(
            rawLink,
            confirmation.destinationDir || settings.destinationDir || app.getPath('downloads'),
            settings.maxDownloadSpeedBytesPerSec ?? 0
          )
          return
        }
        const link = new URL(rawLink)
        const infoHash = link.searchParams.get('xt') || ''
        if (
          link.protocol !== 'magnet:' ||
          !/^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$|^urn:btmh:1220[a-f\d]{64}$/i.test(infoHash)
        ) {
          throw new Error('This magnet link has no valid torrent identifier.')
        }
        if (!downloadManager || !torrentManager)
          throw new Error('FluxFetch torrent support is not ready yet.')

        showWindow()
        const name = [...(link.searchParams.get('dn') || 'Magnet torrent')]
          .filter((character) => {
            const code = character.charCodeAt(0)
            return code >= 32 && code !== 127
          })
          .join('')
          .trim()
          .slice(0, 240)
        const confirmation = await downloadManager.confirmExternalDownload(
          name || 'Magnet torrent',
          'BitTorrent · magnet link'
        )
        if (!confirmation.accepted) return

        const settings = await loadSettings()
        await torrentManager.add(
          link.href,
          confirmation.destinationDir || settings.destinationDir || app.getPath('downloads'),
          settings.maxDownloadSpeedBytesPerSec ?? 0
        )
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'FluxFetch could not open this link.'
        console.error('[magnet protocol]', message)
        const options = {
          type: 'error' as const,
          title: 'Could not add torrent',
          message
        }
        if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options)
        else void dialog.showMessageBox(options)
      })
  }
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  handleProtocolArguments([path])
})

function setWindowTaskbarDetails(window: BrowserWindow): void {
  if (process.platform !== 'win32') return
  window.setIcon(windowsIcon)
  if (app.isPackaged) {
    window.setAppDetails({
      appId: 'com.fluxfetch.app',
      appIconPath: process.execPath,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`,
      relaunchDisplayName: 'FluxFetch'
    })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'FluxFetch',
    // Matches the renderer's dark-mode background so a live window resize
    // (which briefly exposes the raw window background) doesn't flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171925' : '#f4f5fb',
    ...(process.platform !== 'darwin'
      ? { icon: process.platform === 'win32' ? windowsIcon : icon }
      : {}),
    // Design v2 draws its own title bar. Windows caption controls are drawn in the renderer so
    // their hit targets and hover states match the rest of the app.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden'
          }
        : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // A hidden e2e window would otherwise have its timers throttled.
      backgroundThrottling: !testKnobs.hideWindow
    }
  })
  setWindowTaskbarDetails(mainWindow)

  mainWindow.on('ready-to-show', () => {
    if (!testKnobs.hideWindow) mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (tray && !quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS shell — an arbitrary scheme (e.g. a custom protocol
    // handler) reaching shell.openExternal is a known Electron risk if this ever fires with
    // attacker- or server-influenced data.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const sendWindowState = (): void => {
    if (!mainWindow?.isDestroyed())
      mainWindow?.webContents.send('window:state-changed', mainWindow.isMaximized())
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function openDownloadWindow(downloadId: string): void {
  const existing = downloadWindows.get(downloadId)
  if (existing && !existing.isDestroyed()) {
    presentWindow(existing)
    return
  }

  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'FluxFetch download',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    ...(process.platform !== 'darwin'
      ? { icon: process.platform === 'win32' ? windowsIcon : icon }
      : {}),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden'
          }
        : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      backgroundThrottling: !testKnobs.hideWindow
    }
  })
  setWindowTaskbarDetails(window)
  downloadWindows.set(downloadId, window)
  window.on('ready-to-show', () => {
    if (!testKnobs.hideWindow) {
      presentWindow(window)
    }
  })
  window.on('closed', () => {
    if (downloadWindows.get(downloadId) === window) downloadWindows.delete(downloadId)
  })
  window.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const sendWindowState = (): void => {
    if (!window.isDestroyed()) window.webContents.send('window:state-changed', window.isMaximized())
  }
  window.on('maximize', sendWindowState)
  window.on('unmaximize', sendWindowState)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    url.searchParams.set('downloadId', downloadId)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { downloadId }
    })
  }
}

app.whenReady().then(async () => {
  if (!primary) return
  electronApp.setAppUserModelId('com.fluxfetch.app')
  if (
    process.platform === 'win32' &&
    app.isPackaged &&
    !testKnobs.userDataDir &&
    !app.isDefaultProtocolClient('magnet')
  ) {
    const registered = app.setAsDefaultProtocolClient('magnet')
    if (!registered) console.warn('FluxFetch could not register as the Windows magnet handler.')
  }

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[fluxfetch] failed to migrate network-preferences.json', error)
  )

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  torrentManager = new TorrentManager(() => BrowserWindow.getAllWindows())
  await torrentManager.start().catch((error) => console.error('[torrent]', error))

  downloadManager = registerIpcHandlers(
    () => mainWindow,
    () => BrowserWindow.getAllWindows(),
    openDownloadWindow,
    torrentManager
  )
  await restartRemoteManagement(downloadManager).catch((error) =>
    console.error('[remote-management]', error)
  )

  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
  })

  createWindow()
  windowsInitialized = true
  finishProtocolInitialization()
  handleProtocolArguments(process.argv)
  let updatingTransferStatus = false
  let lastTrayTooltip = ''
  const updateTransferStatus = async (): Promise<void> => {
    if (updatingTransferStatus || quitting || !downloadManager || !torrentManager) return
    updatingTransferStatus = true
    try {
      const summary = createTransferSummary(
        await downloadManager.listTransferProgress(),
        torrentManager.getProgressSnapshot()
      )
      const tooltip = transferTrayTooltip(summary)
      if (tray && !tray.isDestroyed() && tooltip !== lastTrayTooltip) {
        tray.setToolTip(tooltip)
        lastTrayTooltip = tooltip
      }
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(IpcChannels.transferSummaryUpdated, summary)
        }
    } catch (error) {
      console.error('[transfer-status]', error)
    } finally {
      updatingTransferStatus = false
    }
  }
  transferStatusTimer = setInterval(() => void updateTransferStatus(), 1000)
  transferStatusTimer.unref()
  if (process.platform === 'win32' && !testKnobs.userDataDir) {
    tray = new Tray(icon)
    tray.setToolTip('FluxFetch — no active downloads')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open FluxFetch', click: showWindow },
        { label: 'Quit FluxFetch', click: () => app.quit() }
      ])
    )
    tray.on('double-click', showWindow)
  }
  void updateTransferStatus()
  if (process.platform === 'win32' && (!testKnobs.userDataDir || testKnobs.browserBridge)) {
    browserBridge = await startBrowserBridge(downloadManager, showWindow, torrentManager).catch(
      (error) => {
        console.error('Browser bridge:', error)
        return null
      }
    )
  }
  if (testKnobs.hideWindow) app.dock?.hide()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (transferStatusTimer) clearInterval(transferStatusTimer)
  transferStatusTimer = null
  quitting = true
  browserBridge?.close()
  void stopRemoteManagement()
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void Promise.all([downloadManager.suspendAll(), torrentManager?.shutdown()]).finally(() => {
    clearTimeout(forceQuitTimeout)
    quitAfterSuspending = true
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
