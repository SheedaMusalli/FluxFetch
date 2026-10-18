import { ColorBadge } from './ColorBadge'
import { ThemeToggle } from './ThemeToggle'
import { UpdateIndicator } from './UpdateIndicator'
import { Button } from './ui/button'
import { Copy, ListPlus, Minus, PanelBottomClose, Settings2, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import fluxFetchLogo from '../assets/fluxfetch-mark.svg'

export type TitleBarStatus =
  | { kind: 'none' }
  | { kind: 'combined'; networkCount: number }
  | { kind: 'paused'; networkCount: number }
  | { kind: 'offline' }

const isMac = window.plexo.platform === 'darwin'

const pillClass =
  'h-auto flex items-center gap-[7px] rounded-full px-2.5 py-1 font-mono text-[10px] leading-none font-semibold tracking-[0.08em] uppercase whitespace-nowrap'
const pillDotClass = 'size-1.5 shrink-0 rounded-full'

export function TitleBar({
  status,
  queueCount,
  onOpenQueue,
  onOpenSettings,
  libraryWindow = true
}: {
  status: TitleBarStatus
  queueCount: number
  onOpenQueue: () => void
  onOpenSettings: () => void
  libraryWindow?: boolean
}): React.JSX.Element {
  const dimmed = status.kind === 'offline'
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (window.plexo.platform !== 'win32') return
    void window.plexo.isWindowMaximized().then(setMaximized)
    return window.plexo.onWindowStateChanged(setMaximized)
  }, [])

  return (
    <div
      className={`flex h-11 shrink-0 items-center gap-[13px] border-b-[0.5px] border-border bg-card [-webkit-app-region:drag] ${
        // Real traffic lights are inset here on macOS (see main/index.ts, trafficLightPosition) —
        // 16px inset + ~52px cluster width + a clear ~26px gap before our own content starts.
        isMac ? 'pl-[94px]' : 'pl-3.5'
      }`}
      style={
        window.plexo.platform === 'win32' ? { paddingLeft: '14px', paddingRight: 0 } : undefined
      }
    >
      <div
        className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
        aria-label="FluxFetch"
      >
        <img src={fluxFetchLogo} alt="" className="size-[24px] rounded-[7px] object-contain" />
        <span
          className={`font-sans text-[13px] leading-none font-bold tracking-[-0.02em] ${
            dimmed ? 'text-muted-foreground' : 'text-foreground'
          }`}
        >
          FluxFetch
        </span>
      </div>
      <div className="flex-1" />
      {status.kind === 'combined' && (
        <ColorBadge
          bg="var(--color-wifi-bg)"
          border="var(--color-wifi-border)"
          text="var(--color-wifi-text)"
          className={pillClass}
        >
          <div
            className={`${pillDotClass} bg-[var(--color-wifi)] animate-[plexo-glow_2s_ease-in-out_infinite]`}
          />
          {status.networkCount} {status.networkCount === 1 ? 'network' : 'networks'} combined
        </ColorBadge>
      )}
      {status.kind === 'paused' && (
        <ColorBadge
          bg="var(--color-usb-bg)"
          border="var(--color-usb-border)"
          text="var(--color-usb-text)"
          className={pillClass}
        >
          <div className={`${pillDotClass} bg-[var(--color-usb)]`} />
          {status.networkCount} {status.networkCount === 1 ? 'network' : 'networks'} · Paused
        </ColorBadge>
      )}
      {status.kind === 'offline' && (
        <ColorBadge
          bg="var(--color-danger-bg)"
          border="var(--color-danger-border)"
          text="var(--color-danger)"
          className={pillClass}
        >
          <div className={`${pillDotClass} bg-[var(--color-danger)]`} />
          Offline
        </ColorBadge>
      )}
      {libraryWindow && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px] [-webkit-app-region:no-drag]"
          onClick={onOpenQueue}
          aria-label={`Open download queue${queueCount ? `, ${queueCount} waiting` : ''}`}
        >
          <ListPlus className="size-3.5" />
          Queue
          {queueCount > 0 && (
            <span className="font-mono text-[9px] text-muted-foreground">{queueCount}</span>
          )}
        </Button>
      )}
      {libraryWindow && <UpdateIndicator />}
      <ThemeToggle />
      {libraryWindow && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-[26px] shrink-0 [-webkit-app-region:no-drag]"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Settings2 className="size-3.5" />
        </Button>
      )}
      {libraryWindow && window.plexo.platform === 'win32' && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-[26px] shrink-0 [-webkit-app-region:no-drag]"
          onClick={() => void window.plexo.minimizeToTray()}
          aria-label="Minimize FluxFetch to tray"
          title="Minimize to tray"
        >
          <PanelBottomClose className="size-3.5" />
        </Button>
      )}
      {window.plexo.platform === 'win32' && (
        <div
          className="ml-1 flex h-11 shrink-0 [-webkit-app-region:no-drag]"
          aria-label="Window controls"
        >
          <button
            type="button"
            className="flex h-11 w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => void window.plexo.minimizeWindow()}
            aria-label="Minimize window"
            title="Minimize"
          >
            <Minus className="size-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="flex h-11 w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => void window.plexo.toggleWindowMaximize()}
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            title={maximized ? 'Restore' : 'Maximize'}
          >
            {maximized ? (
              <Copy className="size-3" strokeWidth={1.4} />
            ) : (
              <Square className="size-3" strokeWidth={1.4} />
            )}
          </button>
          <button
            type="button"
            className="flex h-11 w-[46px] items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white"
            onClick={() => void window.plexo.closeWindow()}
            aria-label="Close window"
            title="Close"
          >
            <X className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  )
}
