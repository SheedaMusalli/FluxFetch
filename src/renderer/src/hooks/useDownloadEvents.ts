import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { rememberDownload } from '../history'

/** Subscribes once to main-process download progress pushes for the lifetime of the app. */
export function useDownloadEvents(downloadId?: string | null): void {
  const receiveDownloadUpdate = useAppStore((store) => store.receiveDownloadUpdate)

  useEffect(() => {
    let disposed = false
    const sequences = new Map<string, number>()
    const peaks = new Map<string, number>()
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed; each
    // update carries a count, so whichever arrives late can't undo the other.
    const handleUpdate = (update: Parameters<typeof receiveDownloadUpdate>[0]): void => {
      if (disposed) return
      if (downloadId) {
        if (update.state.id === downloadId) receiveDownloadUpdate(update)
        return
      }
      const id = update.state.id
      if (update.seq <= (sequences.get(id) ?? -1)) return
      sequences.set(id, update.seq)
      const peak = Math.max(peaks.get(id) ?? 0, update.state.speedBytesPerSec)
      peaks.set(id, peak)
      rememberDownload({ ...update.state, blocks: [] }, peak)
    }
    const unsubscribe = window.fluxfetch.onDownloadUpdated(handleUpdate)

    const snapshotPromise = downloadId
      ? window.fluxfetch.getDownload(downloadId).then((snapshot) => (snapshot ? [snapshot] : []))
      : window.fluxfetch.listDownloads()
    void snapshotPromise
      .then((snapshots) => {
        for (const snapshot of snapshots) handleUpdate(snapshot)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [downloadId, receiveDownloadUpdate])
}
