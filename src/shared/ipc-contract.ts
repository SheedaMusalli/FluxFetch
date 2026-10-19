import type {
  AppSettings,
  ArchiveEntryInfo,
  SiteAuthInput,
  DownloadConfirmationResponse,
  DownloadUpdate,
  NetworkInterfaceInfo,
  NetworkSpeedSample,
  ProbeResult,
  QueuedDownload,
  SpeedTestDirection,
  StartDownloadRequest,
  UpdateInfo
} from './types'
import type { TorrentTransfer } from './torrent'
import type { TransferSummary } from './transfers'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated and networksChanged) — one source of truth for
 * both fluxfetchApi (preload) and registerIpcHandlers (main), so a signature drift between the two
 * is a compile error instead of a runtime one. */
export interface IpcContract {
  getTransferSummary: { args: []; result: TransferSummary }
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  pingInterfaces: { args: []; result: Record<string, number | null> }
  measureNetworkSpeedSample: {
    args: [requestId: string, networkId: string, direction: SpeedTestDirection, bytes: number]
    result: NetworkSpeedSample
  }
  cancelNetworkSpeedSample: { args: [requestId: string]; result: void }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string, userAgent?: string]; result: ProbeResult }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  readClipboardText: { args: []; result: string }
  revealInFolder: { args: [filePath: string]; result: void }
  openFile: { args: [filePath: string]; result: void }
  trashFile: { args: [filePath: string]; result: void }
  runOmniLink: { args: []; result: void }
  previewZip: { args: [filePath: string]; result: ArchiveEntryInfo[] }
  extractZipEntries: {
    args: [filePath: string, entries: string[], destination: string]
    result: number
  }
  openExternalUrl: { args: [url: string]; result: void }
  addTorrent: { args: [source: string]; result: boolean }
  chooseTorrentFile: { args: []; result: boolean }
  listTorrents: { args: []; result: TorrentTransfer[] }
  pauseTorrent: { args: [gid: string]; result: void }
  resumeTorrent: { args: [gid: string]; result: void }
  reannounceTorrent: { args: [gid: string]; result: void }
  openTorrentFolder: { args: [gid: string]; result: void }
  removeTorrent: { args: [gid: string, deleteFiles: boolean]; result: void }
  listSiteAuthOrigins: { args: []; result: string[] }
  saveSiteAuth: { args: [input: SiteAuthInput]; result: void }
  removeSiteAuth: { args: [origin: string]; result: void }
  saveRemoteCredentials: { args: [username: string, password: string]; result: void }
  remoteAccessInfo: {
    args: []
    result: { running: boolean; port: number; addresses: string[]; fingerprint?: string }
  }
  saveProxyConfig: { args: [server: string, username: string, password: string]; result: void }
  proxyConfigInfo: { args: []; result: { server: string; enabled: boolean } }
  respondDownloadConfirmation: {
    args: [requestId: string, response: DownloadConfirmationResponse]
    result: void
  }
  getQueuedDownloads: { args: []; result: QueuedDownload[] }
  queueDownloads: {
    args: [urls: string[], destinationDir: string, scheduledAt: number | null]
    result: void
  }
  cancelQueuedDownload: { args: [id: string]; result: void }
  startDownload: { args: [request: StartDownloadRequest]; result: string }
  getCurrentDownload: { args: []; result: DownloadUpdate | null }
  getDownload: { args: [id: string]; result: DownloadUpdate | null }
  openDownloadWindow: { args: [id: string]; result: void }
  showMainWindow: { args: [retryUrl?: string]; result: void }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  removeDownload: { args: [id: string]; result: void }
  checkForUpdate: { args: []; result: UpdateInfo | null }
  minimizeToTray: { args: []; result: void }
  windowMinimize: { args: []; result: void }
  windowToggleMaximize: { args: []; result: void }
  windowClose: { args: []; result: void }
  windowIsMaximized: { args: []; result: boolean }
}
