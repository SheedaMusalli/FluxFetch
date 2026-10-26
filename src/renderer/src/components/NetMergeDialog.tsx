import { useEffect, useState } from 'react'
import { Network, Play, Square } from 'lucide-react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import type { NetMergeStatus } from '../../../shared/netMerge'

export function NetMergeDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<NetMergeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [limits, setLimits] = useState<Record<string, string>>({})
  const [budgets, setBudgets] = useState<Record<string, { gb?: string; daily?: boolean }>>({})
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const next = await window.fluxfetch.netMergeStatus()
        if (!cancelled) setStatus(next)
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 1500)
      }
    }
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open])
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      setStatus(await window.fluxfetch.netMergeStatus())
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)).replace(
          /^Error invoking remote method .*?:\s*/,
          ''
        )
      )
    } finally {
      setBusy(false)
    }
  }
  const rate = (n: number): string => `${((n * 8) / 1e6).toFixed(1)} Mbit/s`
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Network /> Net Merge
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="wide" className="overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Net Merge</DialogTitle>
            <DialogDescription>
              Combine independent internet connections across your Windows apps.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 p-4">
            <div>
              <p className="font-semibold">
                {!status
                  ? 'Checking engine…'
                  : status.phase === 'unresponsive'
                    ? 'Engine status stopped updating'
                    : status.phase === 'starting'
                      ? 'Starting network engine…'
                      : status.running
                        ? 'Merging connections'
                        : 'Ready when you are'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Destination affinity · adaptive balancing · latency-aware TCP
              </p>
            </div>
            <Button
              disabled={busy || !status || (!status.installed && !status.running)}
              onClick={() =>
                void act(() => window.fluxfetch.netMergeControl(status?.running ? 'stop' : 'start'))
              }
            >
              {status?.running ? <Square /> : <Play />}
              {busy ? 'Working…' : status?.running ? 'Stop' : 'Start'}
            </Button>
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {status?.phase === 'unresponsive' && (
            <p role="alert" className="rounded-lg border p-3 text-xs">
              The engine process is still present. Adapter figures may be out of date. Press Stop to
              request shutdown before restarting.
            </p>
          )}
          {status && !status.installed && (
            <p role="status">
              The Net Merge engine is missing. Reinstall FluxFetch or build it with{' '}
              <code>npm run build:net-merge</code>.
            </p>
          )}
          {status?.running && (
            <div className="space-y-3">
              {status.adapters.some(
                (n, i, all) =>
                  n.PublicIP &&
                  n.Present &&
                  all.some((other, j) => j !== i && other.Present && other.PublicIP === n.PublicIP)
              ) && (
                <p
                  role="status"
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
                >
                  Some adapters report the same public IP. They may share one internet line, a
                  carrier NAT, or a VPN. Check your phone is using mobile data; combining these
                  adapters may not increase speed.
                </p>
              )}
              {status.adapters
                .filter((n) => n.Present)
                .map((n) => (
                  <div key={n.Name} className="rounded-lg border p-3">
                    <div className="flex justify-between gap-2">
                      <strong>{n.Name}</strong>
                      <span className="text-xs text-muted-foreground">
                        {n.State} · {n.IP}
                      </span>
                    </div>
                    <div className="my-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        Download<p className="mt-1 font-semibold">{rate(n.RateIn)}</p>
                      </div>
                      <div>
                        Upload<p className="mt-1 font-semibold">{rate(n.RateOut)}</p>
                      </div>
                      <div>
                        TCP connect time
                        <p className="mt-1 font-semibold">
                          {n.RTTMs > 0 ? `${n.RTTMs.toFixed(0)} ms` : 'Measuring…'}
                        </p>
                      </div>
                    </div>
                    <p className="mb-3 text-xs text-muted-foreground">
                      {n.Active} active connections · {((n.BytesIn + n.BytesOut) / 1e9).toFixed(3)}{' '}
                      GB relayed this session
                    </p>
                    {n.QuotaError && (
                      <p role="alert" className="mb-3 text-xs text-destructive">
                        Budget storage failed; this adapter is paused. {n.QuotaError}
                      </p>
                    )}
                    {n.PublicIP && (
                      <p className="mb-3 text-xs text-muted-foreground">Public IP: {n.PublicIP}</p>
                    )}
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void act(() =>
                          window.fluxfetch.netMergeLimit(
                            n.Name,
                            Number(limits[n.Name] ?? n.LimitMbps)
                          )
                        )
                      }}
                    >
                      <label className="text-xs" htmlFor={`net-limit-${n.Name}`}>
                        Speed limit (Mbit/s)
                      </label>
                      <input
                        id={`net-limit-${n.Name}`}
                        className="w-24 rounded border bg-background px-2 py-1"
                        type="number"
                        min="0"
                        max="100000"
                        step="0.1"
                        required
                        value={limits[n.Name] ?? String(n.LimitMbps)}
                        onChange={(e) => setLimits((v) => ({ ...v, [n.Name]: e.target.value }))}
                      />
                      <Button size="sm" variant="outline" disabled={busy} type="submit">
                        Apply
                      </Button>
                      <span className="text-xs text-muted-foreground">0 = unlimited</span>
                    </form>
                    <form
                      className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void act(() =>
                          window.fluxfetch.netMergeQuota({
                            adapter: n.Name,
                            gb: Number(budgets[n.Name]?.gb ?? n.QuotaBytes / 1e9),
                            daily:
                              budgets[n.Name]?.daily ?? (n.QuotaBytes > 0 ? n.QuotaDaily : true),
                            reset: false
                          })
                        )
                      }}
                    >
                      <label className="text-xs" htmlFor={`net-budget-${n.Name}`}>
                        Data budget (GB)
                      </label>
                      <input
                        id={`net-budget-${n.Name}`}
                        className="w-24 rounded border bg-background px-2 py-1"
                        type="number"
                        min="0"
                        max="1000000"
                        step="0.001"
                        required
                        value={budgets[n.Name]?.gb ?? String(n.QuotaBytes / 1e9)}
                        onChange={(e) =>
                          setBudgets((v) => ({
                            ...v,
                            [n.Name]: { ...v[n.Name], gb: e.target.value }
                          }))
                        }
                      />
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={
                            budgets[n.Name]?.daily ?? (n.QuotaBytes > 0 ? n.QuotaDaily : true)
                          }
                          onChange={(e) =>
                            setBudgets((v) => ({
                              ...v,
                              [n.Name]: { ...v[n.Name], daily: e.target.checked }
                            }))
                          }
                        />
                        Reset daily (UTC)
                      </label>
                      <Button size="sm" variant="outline" disabled={busy} type="submit">
                        Save budget
                      </Button>
                      {n.QuotaBytes > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          type="button"
                          onClick={() =>
                            void act(() =>
                              window.fluxfetch.netMergeQuota({
                                adapter: n.Name,
                                gb: n.QuotaBytes / 1e9,
                                daily: n.QuotaDaily,
                                reset: true
                              })
                            )
                          }
                        >
                          Reset usage
                        </Button>
                      )}
                      <p className="w-full text-xs text-muted-foreground">
                        {n.QuotaBytes > 0
                          ? `${(n.QuotaUsed / 1e9).toFixed(3)} / ${(n.QuotaBytes / 1e9).toFixed(3)} GB used${n.QuotaBlocked ? ' · adapter paused' : ''}`
                          : '0 = unlimited'}{' '}
                        · applies to payload relayed by Net Merge.
                      </p>
                    </form>
                  </div>
                ))}
            </div>
          )}
          <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p>
              Use separate internet lines, such as home broadband and a phone using mobile data.
              Wi-Fi and Ethernet on the same router usually share one upstream connection.
            </p>
            <p>
              New parallel connections can use different links; one existing connection stays on one
              link. Windows requests administrator permission for the engine. Stop Net Merge before
              using OmniLink.
            </p>
            <p>
              Closing this panel or FluxFetch leaves the engine running. Reopen this panel and press
              Stop to restore normal routing.
            </p>
            <p>
              Public-IP diagnostics contact Cloudflare through each adapter. Budgets exclude packet
              headers, retransmissions and traffic that bypasses Net Merge. After a restart, up to 1
              MiB reserved per adapter may be counted as used.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
