export interface TorrentTransfer {
  gid: string
  name: string
  infoHash: string
  status:
    | 'active'
    | 'waiting'
    | 'paused'
    | 'complete'
    | 'error'
    | 'removed'
    | 'metadata'
    | 'checking'
    | 'stalled'
    | 'seeding'
  totalBytes: number
  downloadedBytes: number
  uploadedBytes: number
  downloadSpeed: number
  uploadSpeed: number
  downloadLimit?: number
  uploadLimit?: number
  peers: number
  seeders: number
  destinationDir: string
  contentPath?: string | null
  contentDirectory?: string
  sequentialDownload?: boolean
  error?: string
  files?: Array<{ path: string; size: number; downloaded: number }>
  trackers?: Array<{ url: string; status: string; peers: number }>
  peerDetails?: Array<{
    address: string
    client: string
    downloadSpeed: number
    uploadSpeed: number
    progress: number
  }>
  ratio?: number
  etaSeconds?: number | null
  dhtNodes?: number
  listenPort?: number
  diagnostic?: string
  engineMessages?: string[]
  engine?: string
}
