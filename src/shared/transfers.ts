import type { TorrentTransfer } from './torrent'

export interface TransferProgress {
  id: string
  kind: 'normal' | 'torrent'
  name: string
  status: string
  totalBytes: number
  downloadedBytes: number
  downloadSpeed: number
  uploadSpeed: number
  destinationPath?: string
  startedAt?: number
}

export interface TransferSummary {
  items: TransferProgress[]
  downloadSpeed: number
  uploadSpeed: number
}

export const transferStatusLabels: Record<string, string> = {
  downloading: 'Downloading',
  active: 'Downloading',
  paused: 'Paused',
  error: 'Error',
  metadata: 'Fetching metadata',
  checking: 'Checking files',
  stalled: 'Waiting for peers',
  waiting: 'Queued',
  seeding: 'Seeding',
  complete: 'Complete'
}

export function transferPercent(
  item: Pick<TransferProgress, 'totalBytes' | 'downloadedBytes'>
): number | null {
  return item.totalBytes > 0
    ? Math.min(100, Math.max(0, (item.downloadedBytes / item.totalBytes) * 100))
    : null
}

export function transferRate(value: number): string {
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`
  return `${(Math.max(0, value) / 1024).toFixed(1)} KB/s`
}

export function createTransferSummary(
  normal: TransferProgress[],
  torrents: readonly TorrentTransfer[]
): TransferSummary {
  const items = [
    ...normal,
    ...torrents
      .filter((item) => item.status !== 'removed')
      .map((item): TransferProgress => ({
        id: item.gid,
        kind: 'torrent',
        name: item.name,
        status: item.status,
        destinationPath: item.contentPath || item.contentDirectory || item.destinationDir,
        totalBytes: item.totalBytes,
        downloadedBytes: item.downloadedBytes,
        downloadSpeed: item.status === 'active' ? item.downloadSpeed : 0,
        uploadSpeed: ['active', 'seeding'].includes(item.status) ? item.uploadSpeed : 0
      }))
  ]
  return {
    items,
    downloadSpeed: items.reduce((sum, item) => sum + item.downloadSpeed, 0),
    uploadSpeed: items.reduce((sum, item) => sum + item.uploadSpeed, 0)
  }
}

function groupText(label: string, items: TransferProgress[]): string {
  const downloading = items.filter((item) => !['seeding', 'complete'].includes(item.status))
  if (!downloading.length)
    return `${label}: Seeding 100% ↑${transferRate(items.reduce((sum, item) => sum + item.uploadSpeed, 0))}`
  const total = downloading.reduce((sum, item) => sum + item.totalBytes, 0)
  const done = downloading.reduce(
    (sum, item) => sum + Math.min(item.downloadedBytes, item.totalBytes),
    0
  )
  const known = downloading.every((item) => item.totalBytes > 0)
  const percent = known && total > 0 ? `${((done / total) * 100).toFixed(1)}%` : 'Size unknown'
  const states = new Set(downloading.map((item) => item.status))
  const state =
    states.size === 1 ? transferStatusLabels[downloading[0].status] : `${downloading.length} jobs`
  const speed = items.reduce((sum, item) => sum + item.downloadSpeed, 0)
  return `${label}: ${percent} ${state} ↓${transferRate(speed)}`
}

/** Windows tray tooltips have a 128 UTF-16 character buffer including the terminator. */
export function transferTrayTooltip(summary: TransferSummary): string {
  if (!summary.items.length) return 'FluxFetch — no active downloads'
  const lines = ['FluxFetch']
  for (const [kind, label] of [
    ['normal', 'Normal'],
    ['torrent', 'Torrent']
  ] as const) {
    const items = summary.items.filter((item) => item.kind === kind)
    if (items.length) lines.push(groupText(label, items))
  }
  if (summary.uploadSpeed > 0 && summary.items.some((item) => item.status !== 'seeding'))
    lines.push(`Upload ↑${transferRate(summary.uploadSpeed)}`)
  const value = lines.join('\n')
  let output = ''
  for (const character of value) {
    if (output.length + character.length > 127) break
    output += character
  }
  return output
}
