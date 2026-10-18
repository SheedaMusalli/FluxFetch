import { Settings2, FolderOpen, Palette, RefreshCw, ListPlus } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { useEffect, useState } from 'react'

export function SettingsDialog({
  open,
  onOpenChange,
  onOpenQueue
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenQueue: () => void
}): React.JSX.Element {
  const destinationDir = useAppStore((s) => s.destinationDir)
  const downloadsDir = useAppStore((s) => s.downloadsDir)
  const theme = useAppStore((s) => s.themeSource)
  const setTheme = useAppStore((s) => s.setThemeSource)
  const speedLimit = useAppStore((s) => s.maxDownloadSpeedBytesPerSec)
  const setSpeedLimit = useAppStore((s) => s.setDownloadSpeedLimit)
  const clipboardMonitoring = useAppStore((s) => s.clipboardMonitoring)
  const setClipboardMonitoring = useAppStore((s) => s.setClipboardMonitoring)
  const customUserAgent = useAppStore((s) => s.customUserAgent)
  const setCustomUserAgent = useAppStore((s) => s.setCustomUserAgent)
  const checkForUpdate = useAppStore((s) => s.checkForUpdate)
  const [torrentUrl, setTorrentUrl] = useState('http://127.0.0.1:8080')
  const [torrentUsername, setTorrentUsername] = useState('')
  const [torrentPassword, setTorrentPassword] = useState('')
  const [torrentStatus, setTorrentStatus] = useState('')
  const [torrentBusy, setTorrentBusy] = useState(false)
  const [authOrigins, setAuthOrigins] = useState<string[]>([])
  const [authOrigin, setAuthOrigin] = useState('https://')
  const [authCookie, setAuthCookie] = useState('')
  const [authHeader, setAuthHeader] = useState('')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [remote, setRemote] = useState(window.plexo.initialState.remoteManagement)
  const [remoteUsername, setRemoteUsername] = useState(remote.username)
  const [remotePassword, setRemotePassword] = useState('')
  const [remoteStatus, setRemoteStatus] = useState('')
  const [remoteInfo, setRemoteInfo] = useState<{
    running: boolean
    port: number
    addresses: string[]
    fingerprint?: string
  } | null>(null)
  const [remoteBusy, setRemoteBusy] = useState(false)
  const setProxyEnabled = useAppStore((s) => s.setProxyEnabled)
  const [proxyServer, setProxyServer] = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')
  const [proxyStatus, setProxyStatus] = useState('')
  const [proxyBusy, setProxyBusy] = useState(false)
  useEffect(() => {
    if (open)
      void window.plexo
        .listSiteAuthOrigins()
        .then(setAuthOrigins)
        .catch(() => {})
  }, [open])
  useEffect(() => {
    if (open)
      void window.plexo
        .remoteAccessInfo()
        .then(setRemoteInfo)
        .catch(() => {})
  }, [open, remote.enabled])
  useEffect(() => {
    if (open)
      void window.plexo
        .proxyConfigInfo()
        .then((info) => setProxyServer(info.server))
        .catch(() => {})
  }, [open])
  const saveAuth = async (): Promise<void> => {
    setAuthBusy(true)
    setAuthStatus('')
    try {
      await window.plexo.saveSiteAuth({
        origin: authOrigin,
        cookie: authCookie,
        authorization: authHeader,
        username: authUsername,
        password: authPassword
      })
      setAuthCookie('')
      setAuthHeader('')
      setAuthUsername('')
      setAuthPassword('')
      setAuthOrigins(await window.plexo.listSiteAuthOrigins())
      setAuthStatus('Authentication saved securely for this site.')
    } catch (error) {
      setAuthStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setAuthBusy(false)
    }
  }
  const saveAndTestTorrent = async (): Promise<void> => {
    setTorrentBusy(true)
    setTorrentStatus('')
    try {
      await window.plexo.saveTorrentClientConfig({
        baseUrl: torrentUrl,
        username: torrentUsername,
        password: torrentPassword
      })
      setTorrentPassword('')
      setTorrentStatus(await window.plexo.testTorrentClient())
    } catch (error) {
      setTorrentStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setTorrentBusy(false)
    }
  }
  const chooseFolder = async (): Promise<void> => {
    const chosen = await window.plexo.chooseDestinationFolder(destinationDir || downloadsDir)
    if (chosen) useAppStore.getState().setDestinationDir(chosen)
  }
  const saveRemote = async (): Promise<void> => {
    setRemoteBusy(true)
    setRemoteStatus('')
    try {
      await window.plexo.saveRemoteCredentials(remoteUsername, remotePassword)
      const next = { ...remote, username: remoteUsername.trim() }
      await window.plexo.updateSettings({ remoteManagement: next })
      setRemote(next)
      setRemotePassword('')
      setRemoteInfo(await window.plexo.remoteAccessInfo())
      setRemoteStatus(
        next.enabled
          ? 'Remote access is running.'
          : 'Credentials saved. Enable remote access to start the server.'
      )
    } catch (error) {
      setRemoteStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoteBusy(false)
    }
  }
  const toggleRemote = async (): Promise<void> => {
    setRemoteBusy(true)
    setRemoteStatus('')
    try {
      const next = { ...remote, enabled: !remote.enabled, username: remoteUsername.trim() }
      await window.plexo.updateSettings({ remoteManagement: next })
      setRemote(next)
      setRemoteInfo(await window.plexo.remoteAccessInfo())
      setRemoteStatus(next.enabled ? 'Remote access is running.' : 'Remote access is stopped.')
    } catch (error) {
      setRemoteStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoteBusy(false)
    }
  }
  const saveProxy = async (): Promise<void> => {
    setProxyBusy(true)
    setProxyStatus('')
    try {
      await window.plexo.saveProxyConfig(proxyServer, proxyUsername, proxyPassword)
      const info = await window.plexo.proxyConfigInfo()
      setProxyServer(info.server)
      setProxyEnabled(info.enabled)
      setProxyUsername('')
      setProxyPassword('')
      setProxyStatus(info.enabled ? 'Proxy saved. New downloads will use it.' : 'Proxy disabled.')
    } catch (error) {
      setProxyStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setProxyBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="wide"
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] sm:max-w-4xl overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="size-4" /> FluxFetch settings
          </DialogTitle>
        </DialogHeader>
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Downloads
          </h3>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">Default save location</div>
            <div className="mb-3 break-all text-xs text-muted-foreground">{destinationDir}</div>
            <Button variant="outline" size="sm" onClick={() => void chooseFolder()}>
              <FolderOpen /> Change folder
            </Button>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-1 text-sm font-medium">Torrent support · qBittorrent</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Enable qBittorrent WebUI on this PC. FluxFetch sends magnet links and .torrent files
              to its local WebUI after your confirmation.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label="qBittorrent WebUI address"
                value={torrentUrl}
                onChange={(event) => setTorrentUrl(event.target.value)}
                placeholder="http://127.0.0.1:8080"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
              />
              <input
                aria-label="qBittorrent WebUI username"
                value={torrentUsername}
                onChange={(event) => setTorrentUsername(event.target.value)}
                placeholder="WebUI username"
                autoComplete="username"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                aria-label="qBittorrent WebUI password"
                type="password"
                value={torrentPassword}
                onChange={(event) => setTorrentPassword(event.target.value)}
                placeholder="WebUI password"
                autoComplete="new-password"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveAndTestTorrent()}
                disabled={torrentBusy}
              >
                {torrentBusy ? 'Connecting…' : 'Save and test connection'}
              </Button>
              {torrentStatus && (
                <span role="status" className="text-xs text-muted-foreground">
                  {torrentStatus}
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Credentials are stored encrypted by Windows. For security, this connection is limited
              to localhost.
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-1 text-sm font-medium">Proxy server</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Route new downloads through HTTP, HTTPS, SOCKS4, or SOCKS5. Proxy credentials are
              encrypted on this PC. Proxy transfers use the operating system route and pause
              multi-network combining.
            </p>
            <input
              aria-label="Proxy server address"
              value={proxyServer}
              onChange={(event) => setProxyServer(event.target.value)}
              placeholder="socks5://proxy.example.com:1080"
              className="mb-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label="Proxy username"
                value={proxyUsername}
                onChange={(event) => setProxyUsername(event.target.value)}
                placeholder="Proxy username (optional)"
                autoComplete="username"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                aria-label="Proxy password"
                type="password"
                value={proxyPassword}
                onChange={(event) => setProxyPassword(event.target.value)}
                placeholder="Proxy password (optional)"
                autoComplete="new-password"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveProxy()}
                disabled={proxyBusy}
              >
                {proxyBusy ? 'Saving…' : 'Save proxy'}
              </Button>
              {proxyStatus && (
                <span role="status" className="text-xs text-muted-foreground">
                  {proxyStatus}
                </span>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-1 text-sm font-medium">Site authentication</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Save a site cookie/session token or HTTP Basic credentials. Secrets are encrypted on
              this PC and sent only to the exact origin. Browser session cookies take precedence.
            </p>
            {authOrigins.length > 0 && (
              <div className="mb-3 space-y-1">
                {authOrigins.map((origin) => (
                  <div
                    key={origin}
                    className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5 text-xs"
                  >
                    <span className="truncate">{origin}</span>
                    <button
                      type="button"
                      className="shrink-0 text-destructive hover:underline"
                      onClick={() =>
                        void window.plexo
                          .removeSiteAuth(origin)
                          .then(() => window.plexo.listSiteAuthOrigins().then(setAuthOrigins))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label="Authentication site origin"
                value={authOrigin}
                onChange={(event) => setAuthOrigin(event.target.value)}
                placeholder="https://example.com"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
              />
              <input
                aria-label="Site cookie or session token"
                type="password"
                autoComplete="off"
                value={authCookie}
                onChange={(event) => setAuthCookie(event.target.value)}
                placeholder="Cookie header or session token"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
              />
              <input
                aria-label="Authorization header"
                type="password"
                autoComplete="off"
                value={authHeader}
                onChange={(event) => setAuthHeader(event.target.value)}
                placeholder="Authorization header (e.g. Bearer …)"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2"
              />
              <input
                aria-label="Basic authentication username"
                autoComplete="off"
                value={authUsername}
                onChange={(event) => setAuthUsername(event.target.value)}
                placeholder="Basic auth username (optional)"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                aria-label="Basic authentication password"
                type="password"
                autoComplete="new-password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="Basic auth password"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveAuth()}
                disabled={authBusy}
              >
                {authBusy ? 'Saving…' : 'Save site authentication'}
              </Button>
              {authStatus && (
                <span role="status" className="text-xs text-muted-foreground">
                  {authStatus}
                </span>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-1 text-sm font-medium">Remote management</div>
            <p className="mb-3 text-xs text-muted-foreground">
              View, start, pause, and cancel downloads from another device. The HTTPS service
              listens on your local network; configure your router to forward this port if you want
              internet access. Use a long, unique password.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label="Remote access username"
                value={remoteUsername}
                onChange={(event) => setRemoteUsername(event.target.value)}
                placeholder="Username"
                autoComplete="username"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                aria-label="Remote access password"
                type="password"
                value={remotePassword}
                onChange={(event) => setRemotePassword(event.target.value)}
                placeholder="New password (14+ characters)"
                autoComplete="new-password"
                className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <label className="text-xs text-muted-foreground">
                HTTPS port
                <input
                  aria-label="Remote access port"
                  type="number"
                  min={1024}
                  max={65535}
                  value={remote.port}
                  onChange={(event) =>
                    setRemote((current) => ({ ...current, port: Number(event.target.value) }))
                  }
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => void saveRemote()}
                disabled={remoteBusy || remotePassword.length < 14}
              >
                {remoteBusy ? 'Saving…' : 'Save credentials and settings'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void toggleRemote()}
                disabled={remoteBusy}
              >
                {remote.enabled ? 'Stop remote access' : 'Enable remote access'}
              </Button>
            </div>
            {remoteInfo?.running && (
              <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                <p>Open one of these addresses from a device on your LAN:</p>
                {remoteInfo.addresses.map((address) => (
                  <p key={address} className="break-all font-mono text-foreground">
                    {address}
                  </p>
                ))}
                {remoteInfo.fingerprint && (
                  <p className="break-all">TLS certificate fingerprint: {remoteInfo.fingerprint}</p>
                )}
              </div>
            )}
            {remoteStatus && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {remoteStatus}
              </p>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              The connection uses a locally generated TLS certificate, so each remote browser may
              ask you to trust it. Verify the fingerprint shown here. Remote access is disabled by
              default.
            </p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <label htmlFor="download-speed-limit" className="mb-1 block text-sm font-medium">
              Maximum download speed
            </label>
            <p className="mb-2 text-xs text-muted-foreground">
              Set 0 for unlimited. Applies across all active FluxFetch transfers.
            </p>
            <div className="flex items-center gap-2">
              <input
                id="download-speed-limit"
                aria-label="Maximum download speed in megabytes per second"
                type="number"
                min="0"
                max="1024"
                step="0.5"
                value={speedLimit === 0 ? '' : (speedLimit / 1048576).toFixed(1)}
                placeholder="Unlimited"
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setSpeedLimit(
                    Number.isFinite(value) && value > 0 ? Math.round(value * 1048576) : 0
                  )
                }}
                className="w-36 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="text-xs text-muted-foreground">MB/s</span>
            </div>
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
            <input
              type="checkbox"
              checked={clipboardMonitoring}
              onChange={(event) => setClipboardMonitoring(event.target.checked)}
              className="mt-0.5 accent-primary"
            />
            <span>
              <span className="block font-medium">Monitor clipboard for download links</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                FluxFetch checks copied text locally and asks before adding a web link.
              </span>
            </span>
          </label>
          <div className="rounded-lg border border-border p-3">
            <label htmlFor="custom-user-agent" className="mb-1 block text-sm font-medium">
              Custom User-Agent
            </label>
            <p className="mb-2 text-xs text-muted-foreground">
              Optional request header for servers that require a specific client signature.
            </p>
            <input
              id="custom-user-agent"
              type="text"
              maxLength={512}
              value={customUserAgent}
              onChange={(event) => setCustomUserAgent(event.target.value)}
              placeholder="Use browser or FluxFetch default"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">Queue and scheduling</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Add multiple links and schedule or download them one at a time.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false)
                onOpenQueue()
              }}
            >
              <ListPlus /> Open download queue
            </Button>
          </div>
        </section>
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Appearance and updates
          </h3>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <span className="flex items-center gap-2 text-sm">
              <Palette className="size-4" /> Theme
            </span>
            <select
              aria-label="Theme"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">Software updates</div>
            <p className="mb-3 text-xs text-muted-foreground">
              FluxFetch checks GitHub at startup, when restored, and every six hours.
            </p>
            <Button variant="outline" size="sm" onClick={() => void checkForUpdate()}>
              <RefreshCw /> Check now
            </Button>
          </div>
        </section>
        <p className="text-xs text-muted-foreground">
          Download confirmation appears before browser downloads. Network controls and stream counts
          are available while preparing each download.
        </p>
      </DialogContent>
    </Dialog>
  )
}
