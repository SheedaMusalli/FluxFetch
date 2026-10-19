import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, FileUp, Link2, Pause, Play, Trash2, XCircle } from 'lucide-react'
import { TorrentDetails } from './TorrentDetails'
import type { TorrentTransfer } from '@shared/torrent'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

const size = (bytes: number): string =>
  bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${(bytes / 1024 ** 3).toFixed(2)} GB`
const rate = (bytes: number): string =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB/s`
    : `${(bytes / 1024).toFixed(0)} KB/s`
const statusLabel: Record<TorrentTransfer['status'], string> = {
  active: 'Downloading',
  waiting: 'Queued',
  paused: 'Paused',
  complete: 'Complete',
  error: 'Error',
  removed: 'Removed',
  metadata: 'Fetching metadata',
  checking: 'Checking files',
  stalled: 'Waiting for peers',
  seeding: 'Seeding'
}

export function TorrentDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [torrents, setTorrents] = useState<TorrentTransfer[]>([])
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<TorrentTransfer | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let mounted = true
    void window.fluxfetch
      .listTorrents()
      .then((items) => mounted && setTorrents(items))
      .catch((e) => mounted && setError(String(e)))
    const unsubscribe = window.fluxfetch.onTorrentsUpdated(setTorrents)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [open])

  const add = async (localFile = false): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (localFile) {
        await window.fluxfetch.chooseTorrentFile()
      } else {
        const value = source.trim()
        if (!value) throw new Error('Paste a magnet link or direct .torrent URL first.')
        const added = await window.fluxfetch.addTorrent(value)
        if (added) setSource('')
      }
      setTorrents(await window.fluxfetch.listTorrents())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const action = async (work: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await work()
      setTorrents(await window.fluxfetch.listTorrents())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    setError('')
    try {
      await window.fluxfetch.removeTorrent(deleteTarget.gid, true)
      setTorrents(await window.fluxfetch.listTorrents())
      setDeleteTarget(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="wide"
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>FluxFetch torrents</DialogTitle>
          <DialogDescription>
            Built-in libtorrent session with peer discovery, tracker diagnostics and resumable
            transfers.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-wrap gap-2">
          <input
            aria-label="Magnet link or torrent URL"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add()
            }}
            placeholder="magnet:?xt=urn:btih:… or https://…/file.torrent"
            className="min-w-[12rem] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <Button onClick={() => void add()} disabled={busy}>
            <Link2 /> Add torrent
          </Button>
          <Button variant="outline" onClick={() => void add(true)} disabled={busy}>
            <FileUp /> Open .torrent
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error.replace(/^Error invoking remote method .*?:\s*/i, '')}
          </p>
        )}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {torrents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              No torrents yet. Add a magnet link or open a .torrent file.
            </div>
          ) : (
            torrents.map((torrent) => {
              const percent = torrent.totalBytes
                ? Math.min(100, (torrent.downloadedBytes / torrent.totalBytes) * 100)
                : torrent.status === 'complete'
                  ? 100
                  : 0
              return (
                <div key={torrent.gid} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={torrent.name}>
                        {torrent.name}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{statusLabel[torrent.status]}</span>
                        <span>{percent.toFixed(1)}%</span>
                        <span>
                          {size(torrent.downloadedBytes)} /{' '}
                          {torrent.totalBytes ? size(torrent.totalBytes) : '—'}
                        </span>
                        <span>↓ {rate(torrent.downloadSpeed)}</span>
                        <span>↑ {rate(torrent.uploadSpeed)}</span>
                        <span>
                          {torrent.peers} peers · {torrent.seeders} seeds
                        </span>
                      </div>
                      {torrent.error && (
                        <div className="mt-1 truncate text-xs text-destructive">
                          {torrent.error}
                        </div>
                      )}
                      {torrent.diagnostic && (
                        <p className="mt-2 text-xs text-muted-foreground">{torrent.diagnostic}</p>
                      )}
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {torrent.status === 'paused' ? (
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="Resume torrent"
                          onClick={() =>
                            void action(() => window.fluxfetch.resumeTorrent(torrent.gid))
                          }
                        >
                          <Play />
                        </Button>
                      ) : [
                          'active',
                          'waiting',
                          'metadata',
                          'checking',
                          'stalled',
                          'seeding'
                        ].includes(torrent.status) ? (
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="Pause torrent"
                          onClick={() =>
                            void action(() => window.fluxfetch.pauseTorrent(torrent.gid))
                          }
                        >
                          <Pause />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove torrent and keep downloaded files"
                        title="Remove torrent (keep files)"
                        onClick={() =>
                          void action(() => window.fluxfetch.removeTorrent(torrent.gid, false))
                        }
                      >
                        <XCircle />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete torrent and downloaded files"
                        title="Delete torrent and files"
                        onClick={() => {
                          setError('')
                          setDeleteTarget(torrent)
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    aria-expanded={expanded === torrent.gid}
                    onClick={() => setExpanded(expanded === torrent.gid ? null : torrent.gid)}
                  >
                    {expanded === torrent.gid ? <ChevronUp /> : <ChevronDown />} Torrent details
                  </Button>
                  {expanded === torrent.gid && (
                    <TorrentDetails
                      torrent={torrent}
                      onOpenFolder={() =>
                        void action(() => window.fluxfetch.openTorrentFolder(torrent.gid))
                      }
                      onReannounce={() =>
                        void action(() => window.fluxfetch.reannounceTorrent(torrent.gid))
                      }
                    />
                  )}
                </div>
              )
            })
          )}
        </div>
      </DialogContent>
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleting) setDeleteTarget(null)
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>Delete torrent and files?</DialogTitle>
            <DialogDescription>
              Remove <span className="font-medium text-foreground">{deleteTarget?.name}</span> and
              permanently delete its downloaded data from disk.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="break-words text-xs text-destructive">
              {error.replace(/^Error invoking remote method .*?:\s*/i, '')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              <Trash2 /> {deleting ? 'Deleting…' : 'Delete files'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
