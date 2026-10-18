import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { IpcContract } from '../shared/ipc-contract'
import type {
  AppSettings,
  DownloadConfirmationRequest,
  DownloadConfirmationResponse,
  DownloadUpdate,
  InitialState,
  NetworkInterfaceInfo,
  QueuedDownload,
  SpeedTestDirection
} from '../shared/types'

/** Typed wrapper around ipcRenderer.invoke — the channel name picks its args/result shape out of
 * IpcContract, so a call here that doesn't match what registerIpcHandlers (main) actually handles
 * is a compile error instead of a silent runtime mismatch. */
function invoke<K extends keyof IpcContract>(
  channel: K,
  ...args: IpcContract[K]['args']
): Promise<IpcContract[K]['result']> {
  return ipcRenderer.invoke(IpcChannels[channel], ...args)
}

const plexoApi = {
  platform: process.platform,
  // Sync on purpose — see InitialState. One small read, once, before the renderer's first paint.
  initialState: ipcRenderer.sendSync(IpcChannels.getInitialState) as InitialState,

  listInterfaces: () => invoke('listInterfaces'),
  pingInterfaces: () => invoke('pingInterfaces'),
  measureNetworkSpeedSample: (
    requestId: string,
    networkId: string,
    direction: SpeedTestDirection,
    bytes: number
  ) => invoke('measureNetworkSpeedSample', requestId, networkId, direction, bytes),
  cancelNetworkSpeedSample: (requestId: string) => invoke('cancelNetworkSpeedSample', requestId),
  deviceBindingSupported: () => invoke('deviceBindingSupported'),
  openNetworkSettings: () => invoke('openNetworkSettings'),
  updateSettings: (patch: AppSettings) => invoke('updateSettings', patch),
  probeUrl: (url: string, userAgent?: string) => invoke('probeUrl', url, userAgent),
  chooseDestinationFolder: (defaultPath: string) => invoke('chooseDestinationFolder', defaultPath),
  readClipboardText: () => invoke('readClipboardText'),
  revealInFolder: (filePath: string) => invoke('revealInFolder', filePath),
  openFile: (filePath: string) => invoke('openFile', filePath),
  trashFile: (filePath: string) => invoke('trashFile', filePath),
  runOmniLink: () => invoke('runOmniLink'),
  previewZip: (filePath: string) => invoke('previewZip', filePath),
  extractZipEntries: (filePath: string, entries: string[], destination: string) =>
    invoke('extractZipEntries', filePath, entries, destination),
  openExternalUrl: (url: string) => invoke('openExternalUrl', url),
  saveTorrentClientConfig: (config: IpcContract['saveTorrentClientConfig']['args'][0]) =>
    invoke('saveTorrentClientConfig', config),
  testTorrentClient: () => invoke('testTorrentClient'),
  listSiteAuthOrigins: () => invoke('listSiteAuthOrigins'),
  saveSiteAuth: (input: IpcContract['saveSiteAuth']['args'][0]) => invoke('saveSiteAuth', input),
  removeSiteAuth: (origin: string) => invoke('removeSiteAuth', origin),
  saveRemoteCredentials: (username: string, password: string) =>
    invoke('saveRemoteCredentials', username, password),
  remoteAccessInfo: () => invoke('remoteAccessInfo'),
  saveProxyConfig: (server: string, username: string, password: string) =>
    invoke('saveProxyConfig', server, username, password),
  proxyConfigInfo: () => invoke('proxyConfigInfo'),
  respondDownloadConfirmation: (requestId: string, response: DownloadConfirmationResponse) =>
    invoke('respondDownloadConfirmation', requestId, response),
  getQueuedDownloads: () => invoke('getQueuedDownloads'),
  queueDownloads: (urls: string[], destinationDir: string, scheduledAt: number | null) =>
    invoke('queueDownloads', urls, destinationDir, scheduledAt),
  cancelQueuedDownload: (id: string) => invoke('cancelQueuedDownload', id),
  startDownload: (request: IpcContract['startDownload']['args'][0]) =>
    invoke('startDownload', request),
  getCurrentDownload: () => invoke('getCurrentDownload'),
  getDownload: (downloadId: string) => invoke('getDownload', downloadId),
  openDownloadWindow: (downloadId: string) => invoke('openDownloadWindow', downloadId),
  showMainWindow: (retryUrl?: string) => invoke('showMainWindow', retryUrl),
  pauseDownload: (downloadId: string) => invoke('pauseDownload', downloadId),
  resumeDownload: (downloadId: string) => invoke('resumeDownload', downloadId),
  setDownloadNetwork: (downloadId: string, networkId: string, enabled: boolean) =>
    invoke('setDownloadNetwork', downloadId, networkId, enabled),
  cancelDownload: (downloadId: string) => invoke('cancelDownload', downloadId),
  removeDownload: (downloadId: string) => invoke('removeDownload', downloadId),
  checkForUpdate: () => invoke('checkForUpdate'),
  minimizeToTray: () => invoke('minimizeToTray'),
  minimizeWindow: () => invoke('windowMinimize'),
  toggleWindowMaximize: () => invoke('windowToggleMaximize'),
  closeWindow: () => invoke('windowClose'),
  isWindowMaximized: () => invoke('windowIsMaximized'),

  onWindowStateChanged: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on(IpcChannels.windowStateChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.windowStateChanged, listener)
  },

  onDownloadUpdated: (callback: (update: DownloadUpdate) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, update: DownloadUpdate): void => callback(update)
    ipcRenderer.on(IpcChannels.downloadUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadUpdated, listener)
  },

  onDownloadConfirmation: (
    callback: (request: DownloadConfirmationRequest) => void
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, request: DownloadConfirmationRequest): void =>
      callback(request)
    ipcRenderer.on(IpcChannels.downloadConfirmation, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadConfirmation, listener)
  },

  onDownloadQueueChanged: (callback: (queue: QueuedDownload[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, queue: QueuedDownload[]): void => callback(queue)
    ipcRenderer.on(IpcChannels.downloadQueueChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadQueueChanged, listener)
  },

  onPrepareRetry: (callback: (url: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, url: string): void => callback(url)
    ipcRenderer.on(IpcChannels.prepareRetry, listener)
    return () => ipcRenderer.removeListener(IpcChannels.prepareRetry, listener)
  },

  onNetworksChanged: (callback: (networks: NetworkInterfaceInfo[]) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, networks: NetworkInterfaceInfo[]): void =>
      callback(networks)
    ipcRenderer.on(IpcChannels.networksChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannels.networksChanged, listener)
  }
}

export type PlexoApi = typeof plexoApi

// Nothing in the renderer needs raw Electron/Node access — only the typed plexoApi above is
// exposed. The @electron-toolkit/preload electronAPI (which hands the renderer an unrestricted
// ipcRenderer.invoke/send/on on any channel) is deliberately not bridged.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('plexo', plexoApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.plexo = plexoApi
}
