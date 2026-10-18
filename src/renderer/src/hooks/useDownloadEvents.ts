import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process download progress pushes for the lifetime of the app. */
export function useDownloadEvents(downloadId?: string | null): void {
  const receiveDownloadUpdate = useAppStore((store) => store.receiveDownloadUpdate)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed; each
    // update carries a count, so whichever arrives late can't undo the other.
    const handleUpdate = (update: Parameters<typeof receiveDownloadUpdate>[0]): void => {
      if (!downloadId || update.state.id === downloadId) receiveDownloadUpdate(update)
    }
    const unsubscribe = window.plexo.onDownloadUpdated(handleUpdate)

    const snapshotPromise = downloadId
      ? window.plexo.getDownload(downloadId)
      : window.plexo.getCurrentDownload()
    void snapshotPromise
      .then((snapshot) => {
        if (!disposed && snapshot) receiveDownloadUpdate(snapshot)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [downloadId, receiveDownloadUpdate])
}
