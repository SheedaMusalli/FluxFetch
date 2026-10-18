import type { DownloadState } from '@shared/types'
export type Entry = Pick<
  DownloadState,
  | 'id'
  | 'fileName'
  | 'url'
  | 'sourcePageUrl'
  | 'destinationPath'
  | 'status'
  | 'totalBytes'
  | 'bytesDownloaded'
  | 'startedAt'
  | 'completedAt'
> & {
  peakSpeedBytesPerSec: number
  avgSpeedBytesPerSec: number
  tags?: string[]
  description?: string
  category?: string
}
export const key = 'plexo-download-history-v1'
export const changedEvent = 'plexo-history-changed'
export function read(): Entry[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}
export function removeEntries(ids: string[]): Entry[] {
  const removed = new Set(ids)
  const entries = read().filter((entry) => !removed.has(entry.id))
  localStorage.setItem(key, JSON.stringify(entries))
  window.dispatchEvent(new Event(changedEvent))
  return entries
}
let lastSaved = { id: '', status: '', at: 0 }
export function rememberDownload(download: DownloadState, peakSpeedBytesPerSec = 0): void {
  if (download.destinationPath.includes('.plexo-youtube-')) return
  if (
    lastSaved.id === download.id &&
    lastSaved.status === download.status &&
    Date.now() - lastSaved.at < 2000
  )
    return
  lastSaved = { id: download.id, status: download.status, at: Date.now() }
  const {
    id,
    fileName,
    url,
    sourcePageUrl,
    destinationPath,
    status,
    totalBytes,
    bytesDownloaded,
    startedAt,
    completedAt
  } = download
  const now = completedAt ?? Date.now()
  const pausedMs = (download.totalPausedMs ?? 0) + (download.pausedAt ? now - download.pausedAt : 0)
  const activeSeconds = Math.max(0, (now - startedAt - pausedMs) / 1000)
  const current = read()
  const previous = current.find((entry) => entry.id === id)
  const entries = current.filter((entry) => entry.id !== id)
  entries.unshift({
    id,
    fileName,
    url,
    sourcePageUrl,
    destinationPath,
    status,
    totalBytes,
    bytesDownloaded,
    startedAt,
    completedAt,
    peakSpeedBytesPerSec,
    avgSpeedBytesPerSec: activeSeconds > 0 ? bytesDownloaded / activeSeconds : 0,
    tags: previous?.tags,
    description: previous?.description,
    category: previous?.category
  })
  try {
    localStorage.setItem(key, JSON.stringify(entries.slice(0, 2000)))
    window.dispatchEvent(new Event(changedEvent))
  } catch {
    /* Preserve app operation if storage is full. */
  }
}
