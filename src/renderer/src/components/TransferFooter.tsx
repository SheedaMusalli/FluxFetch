import { useTransferSummary } from '../hooks/useTransferSummary'
import { ArrowDownToLine, Upload } from 'lucide-react'
import { transferPercent, transferRate, transferStatusLabels } from '@shared/transfers'

export function TransferFooter({
  onTorrents
}: {
  onTorrents: () => void
}): React.JSX.Element | null {
  const transfers = useTransferSummary()
  const items = transfers.items.filter((item) => item.kind === 'torrent')
  const summary = {
    items,
    downloadSpeed: items.reduce((sum, item) => sum + item.downloadSpeed, 0),
    uploadSpeed: items.reduce((sum, item) => sum + item.uploadSpeed, 0)
  }
  if (!summary.items.length) return null
  return (
    <section
      aria-label="Live torrent progress"
      className="w-full rounded-lg border border-border bg-card/70 px-3 py-2 text-xs"
    >
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-muted-foreground">
        <span>{summary.items.length} transfers</span>
        <span className="flex items-center gap-3 font-mono">
          <span className="flex items-center gap-1 text-foreground">
            <ArrowDownToLine className="size-3" />
            {transferRate(summary.downloadSpeed)}
          </span>
          {summary.uploadSpeed > 0 && (
            <span className="flex items-center gap-1">
              <Upload className="size-3" />
              {transferRate(summary.uploadSpeed)}
            </span>
          )}
        </span>
      </div>
      <div className="max-h-32 space-y-1 overflow-y-auto">
        {summary.items.map((item) => {
          const percent = transferPercent(item)
          const state = transferStatusLabels[item.status] ?? item.status
          return (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              aria-label={`${item.kind === 'torrent' ? 'Torrent' : 'Download'}: ${item.name}, ${state}, ${percent === null ? 'size unknown' : `${percent.toFixed(1)}%`}, ${transferRate(item.downloadSpeed)}`}
              title={item.name}
              onClick={() =>
                item.kind === 'torrent'
                  ? onTorrents()
                  : void window.fluxfetch.openDownloadWindow(item.id)
              }
              className="block w-full rounded px-1 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {item.kind === 'torrent' ? 'Torrent' : 'File'}
                </span>
                <span className="min-w-20 flex-1 truncate font-medium text-foreground">
                  {item.name}
                </span>
                <span
                  className={item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}
                >
                  {state}
                </span>
                <span className="min-w-12 text-right font-mono text-primary">
                  {percent === null ? '—' : `${percent.toFixed(1)}%`}
                </span>
                <span className="min-w-24 text-right font-mono text-foreground">
                  ↓ {transferRate(item.downloadSpeed)}
                </span>
                {item.uploadSpeed > 0 && (
                  <span className="font-mono text-muted-foreground">
                    ↑ {transferRate(item.uploadSpeed)}
                  </span>
                )}
              </div>
              <div
                className="mt-1 h-1 overflow-hidden rounded bg-muted"
                role="progressbar"
                aria-label={`${item.name} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                aria-valuetext={percent === null ? state : `${percent.toFixed(1)}%`}
              >
                <div
                  className={`h-full rounded ${item.status === 'error' ? 'bg-destructive' : 'bg-primary'} transition-[width]`}
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}
