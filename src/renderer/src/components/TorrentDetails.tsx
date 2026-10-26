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
const tabs = ['Overview', 'Speed limits', 'Files', 'Trackers', 'Peers'] as const

export function TorrentDetails({
  torrent,
  onOpenFolder,
  onReannounce,
  onSetLimit
}: {
  torrent: TorrentTransfer
  onOpenFolder: () => void
  onReannounce: () => void
  onSetLimit?: (gid: string, downloadLimit: number, uploadLimit: number) => Promise<void>
}): React.JSX.Element {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Overview')
  const [downloadLimitInput, setDownloadLimitInput] = useState<string>(
    torrent.downloadLimit ? String(Math.round(torrent.downloadLimit / 1024)) : ''
  )
  const [uploadLimitInput, setUploadLimitInput] = useState<string>(
    torrent.uploadLimit ? String(Math.round(torrent.uploadLimit / 1024)) : ''
  )
  const [limitNotice, setLimitNotice] = useState<string | null>(null)

  const handleApplyLimits = async (): Promise<void> => {
    if (!onSetLimit) return
    const downKb = Number(downloadLimitInput)
    const upKb = Number(uploadLimitInput)
    const downBytes = Number.isFinite(downKb) && downKb > 0 ? Math.round(downKb * 1024) : 0
    const upBytes = Number.isFinite(upKb) && upKb > 0 ? Math.round(upKb * 1024) : 0
    await onSetLimit(torrent.gid, downBytes, upBytes)
    setLimitNotice('Speed limits updated')
    setTimeout(() => setLimitNotice(null), 3000)
  }
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
                ],
                [
                  'Download limit',
                  torrent.downloadLimit
                    ? `${(torrent.downloadLimit / 1024).toFixed(0)} KB/s`
                    : 'Unlimited'
                ],
                [
                  'Upload limit',
                  torrent.uploadLimit
                    ? `${(torrent.uploadLimit / 1024).toFixed(0)} KB/s`
                    : 'Unlimited'
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
        {tab === 'Speed limits' && (
          <div className="space-y-4 py-1">
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <label className="block text-xs font-semibold text-foreground">
                Download speed limit (KB/s)
              </label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Leave empty or 0 for unlimited transfer rate.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="50"
                  placeholder="Unlimited (0)"
                  value={downloadLimitInput}
                  onChange={(e) => setDownloadLimitInput(e.target.value)}
                  className="w-36 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
                />
                <span className="font-mono text-xs text-muted-foreground">KB/s</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {[
                  ['0', 'Unlimited'],
                  ['500', '500 KB/s'],
                  ['1024', '1 MB/s'],
                  ['2048', '2 MB/s'],
                  ['5120', '5 MB/s'],
                  ['10240', '10 MB/s']
                ].map(([val, lbl]) => (
                  <Button
                    key={val}
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 text-[10px]"
                    onClick={() => setDownloadLimitInput(val === '0' ? '' : val)}
                  >
                    {lbl}
                  </Button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-background/60 p-3">
              <label className="block text-xs font-semibold text-foreground">
                Upload speed limit (KB/s)
              </label>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Leave empty or 0 for unlimited seeding rate.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="50"
                  placeholder="Unlimited (0)"
                  value={uploadLimitInput}
                  onChange={(e) => setUploadLimitInput(e.target.value)}
                  className="w-36 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-primary focus:outline-none"
                />
                <span className="font-mono text-xs text-muted-foreground">KB/s</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {[
                  ['0', 'Unlimited'],
                  ['250', '250 KB/s'],
                  ['500', '500 KB/s'],
                  ['1024', '1 MB/s'],
                  ['2048', '2 MB/s'],
                  ['5120', '5 MB/s']
                ].map(([val, lbl]) => (
                  <Button
                    key={val}
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 text-[10px]"
                    onClick={() => setUploadLimitInput(val === '0' ? '' : val)}
                  >
                    {lbl}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button type="button" size="sm" onClick={() => void handleApplyLimits()}>
                Apply speed limits
              </Button>
              {limitNotice && (
                <span className="text-xs text-emerald-400 font-medium">{limitNotice}</span>
              )}
            </div>
          </div>
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
