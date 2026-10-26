import type { DownloadState } from '@shared/types'
import { legacyHistoryKey } from '@shared/legacyIdentity'
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
  speedBytesPerSec?: number
  tags?: string[]
  description?: string
  category?: string
}
export const key = 'fluxfetch-download-history-v1'
export const changedEvent = 'fluxfetch-history-changed'
export function read(): Entry[] {
  try {
    if (localStorage.getItem(key) === null) {
      const previous = localStorage.getItem(legacyHistoryKey)
      if (previous !== null) {
        localStorage.setItem(key, previous)
        localStorage.removeItem(legacyHistoryKey)
      }
    }
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
const lastSaved = new Map<string, { status: string; at: number }>()
export function rememberDownload(download: DownloadState, peakSpeedBytesPerSec = 0): void {
  if (download.destinationPath.includes('.fluxfetch-youtube-')) return
  const saved = lastSaved.get(download.id)
  if (saved?.status === download.status && Date.now() - saved.at < 2000) return
  lastSaved.set(download.id, { status: download.status, at: Date.now() })
  if (lastSaved.size > 4000) lastSaved.delete(lastSaved.keys().next().value!)
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
    peakSpeedBytesPerSec: Math.max(peakSpeedBytesPerSec, previous?.peakSpeedBytesPerSec ?? 0),
    speedBytesPerSec: download.speedBytesPerSec,
    avgSpeedBytesPerSec: activeSeconds > 0 ? bytesDownloaded / activeSeconds : 0,
    tags: previous?.tags,
    description: previous?.description,
    category: previous?.category
  })
  try {
    const active = entries.filter((entry) => ['downloading', 'paused'].includes(entry.status))
    const inactive = entries.filter((entry) => !['downloading', 'paused'].includes(entry.status))
    localStorage.setItem(key, JSON.stringify([...active, ...inactive.slice(0, 2000)]))
    window.dispatchEvent(new Event(changedEvent))
  } catch {
    /* Preserve app operation if storage is full. */
  }
}
