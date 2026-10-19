import { useState } from 'react'
import type { TorrentTransfer } from '@shared/torrent'
import { Button } from './ui/button'

const bytes = (value: number): string =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(2)} MB`
      : value >= 1024
        ? `${(value / 1024).toFixed(1)} KB`
        : `${value} B`
const speed = (value: number): string => `${(value / 1024).toFixed(1)} KB/s`
const eta = (value: number | null | undefined): string =>
  value == null
    ? 'Waiting for transfer'
    : value < 60
      ? `${value}s`
      : value < 3600
        ? `${Math.ceil(value / 60)} min`
        : `${(value / 3600).toFixed(1)} hours`
const tabs = ['Overview', 'Files', 'Trackers', 'Peers'] as const

export function TorrentDetails({
  torrent,
  onOpenFolder,
  onReannounce
}: {
  torrent: TorrentTransfer
  onOpenFolder: () => void
  onReannounce: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Overview')
  return (
    <div className="mt-2 rounded-lg border border-border bg-background/50 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {tabs.map((name) => (
          <Button
            key={name}
            variant={tab === name ? 'default' : 'ghost'}
            size="sm"
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
          </Button>
        ))}
        <Button variant="outline" size="sm" className="ml-auto" onClick={onReannounce}>
          Find peers
        </Button>
      </div>
      <div className="max-h-64 overflow-auto text-xs">
        {tab === 'Overview' && (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {[
                ['Time remaining', eta(torrent.etaSeconds)],
                [
                  'Uploaded / ratio',
                  `${bytes(torrent.uploadedBytes)} / ${(torrent.ratio ?? 0).toFixed(2)}`
                ],
                [
                  'Discovery',
                  `${torrent.dhtNodes ?? 0} DHT nodes · ${torrent.trackers?.length ?? 0} trackers`
                ],
                ['Listening port', String(torrent.listenPort ?? '—')],
                ['Engine', torrent.engine ?? 'libtorrent'],
                ['File count', String(torrent.files?.length ?? 0)],
                [
                  'Piece selection',
                  torrent.sequentialDownload ? 'Sequential' : 'Normal swarm download'
                ]
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-3 text-muted-foreground">Saving to</div>
            <p className="mt-1 break-all">{torrent.contentPath || torrent.destinationDir}</p>
            {!torrent.contentPath && (
              <p className="mt-1 text-muted-foreground">
                Content location appears after metadata is received.
              </p>
            )}
            <Button variant="outline" size="sm" className="mt-2" onClick={onOpenFolder}>
              Open download folder
            </Button>
            <div className="mt-3 text-muted-foreground">Info hash</div>
            <p className="mt-1 break-all font-mono">{torrent.infoHash}</p>
            {(torrent.engineMessages ?? []).map((message, index) => (
              <p key={index} className="mt-2 break-words text-amber-400">
                {message}
              </p>
            ))}
          </>
        )}
        {tab === 'Files' &&
          (torrent.files?.length ? (
            <div className="space-y-3">
              {torrent.files.map((file) => (
                <div key={file.path}>
                  <div className="flex justify-between gap-3">
                    <span className="min-w-0 break-all">{file.path}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {bytes(file.downloaded)} / {bytes(file.size)}
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary"
                      style={{
                        width: `${file.size ? Math.min(100, (file.downloaded / file.size) * 100) : 100}%`
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              Files appear after torrent metadata is received.
            </p>
          ))}
        {tab === 'Trackers' &&
          (torrent.trackers?.length ? (
            <div className="space-y-3">
              {torrent.trackers.map((tracker) => (
                <div key={tracker.url} className="rounded border border-border p-2">
                  <p className="break-all font-mono">{tracker.url}</p>
                  <p className="mt-1 break-words text-muted-foreground">{tracker.status}</p>
                  <p className="mt-1 text-muted-foreground">{tracker.peers} peers returned</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              No trackers in this torrent. Public torrents can discover peers through DHT and peer
              exchange.
            </p>
          ))}
        {tab === 'Peers' &&
          (torrent.peerDetails?.length ? (
            <div className="space-y-2">
              {torrent.peerDetails.map((peer) => (
                <div
                  key={peer.address}
                  className="flex flex-wrap justify-between gap-2 rounded border border-border p-2"
                >
                  <span className="break-all font-mono">{peer.address}</span>
                  <span>{peer.client || 'Unknown client'}</span>
                  <span>
                    {(peer.progress * 100).toFixed(1)}% · ↓ {speed(peer.downloadSpeed)} · ↑{' '}
                    {speed(peer.uploadSpeed)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">
              No peers connected yet. Check Trackers and DHT node count. A torrent needs reachable
              peers with the requested data to download.
            </p>
          ))}
      </div>
    </div>
  )
}
