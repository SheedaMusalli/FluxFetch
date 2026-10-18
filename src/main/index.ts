import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, nativeTheme, shell, Tray, Menu } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon-dark.png?asset'
import { registerIpcHandlers } from './ipc/handlers'
import { loadThemeSource, migrateLegacyNetworkPreferences } from './settings'
import { testKnobs } from './testKnobs'
import type { DownloadManager } from './download/downloadManager'

import { startBrowserBridge } from './browser/bridge'
import { restartRemoteManagement, stopRemoteManagement } from './remoteManagement'
import { presentWindow } from './windowActivation'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
// Keep existing settings, history, recovery state, and queued links after the visible rebrand.
app.setPath('userData', join(app.getPath('appData'), 'Plexo'))
app.setName('FluxFetch')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

let mainWindow: BrowserWindow | null = null
const downloadWindows = new Map<string, BrowserWindow>()
let downloadManager: DownloadManager | null = null
let quitAfterSuspending = false
let tray: Tray | null = null
let browserBridge: import('node:net').Server | null = null
let quitting = false
const primary = testKnobs.userDataDir ? true : app.requestSingleInstanceLock()
if (!primary) app.quit()
function showWindow(): void {
  if (testKnobs.hideWindow) return
  if (!mainWindow) createWindow()
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  presentWindow(window)
}
app.on('second-instance', showWindow)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'FluxFetch',
    // Matches the renderer's dark-mode background so a live window resize
    // (which briefly exposes the raw window background) doesn't flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171925' : '#f4f5fb',
    ...(process.platform !== 'darwin' ? { icon } : {}),
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
    ...(process.platform !== 'darwin' ? { icon } : {}),
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
  electronApp.setAppUserModelId('com.plexo.app')

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[plexo] failed to migrate network-preferences.json', error)
  )

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  downloadManager = registerIpcHandlers(
    () => mainWindow,
    () => BrowserWindow.getAllWindows(),
    openDownloadWindow
  )
  await restartRemoteManagement(downloadManager).catch((error) =>
    console.error('[remote-management]', error)
  )

  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
  })

  createWindow()
  if (process.platform === 'win32' && !testKnobs.userDataDir) {
    tray = new Tray(icon)
    tray.setToolTip('FluxFetch — downloads continue in the background')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open FluxFetch', click: showWindow },
        { label: 'Quit FluxFetch', click: () => app.quit() }
      ])
    )
    tray.on('double-click', showWindow)
  }
  if (process.platform === 'win32' && (!testKnobs.userDataDir || testKnobs.browserBridge)) {
    browserBridge = await startBrowserBridge(downloadManager, showWindow).catch((error) => {
      console.error('Browser bridge:', error)
      return null
    })
  }
  if (testKnobs.hideWindow) app.dock?.hide()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  quitting = true
  browserBridge?.close()
  void stopRemoteManagement()
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void downloadManager.suspendAll().finally(() => {
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
