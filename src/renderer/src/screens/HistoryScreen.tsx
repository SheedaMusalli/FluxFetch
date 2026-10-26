import { useEffect, useState } from 'react'
import { read, key, changedEvent, removeEntries, type Entry } from '../history'
import { Button } from '../components/ui/button'
import { TransferFooter } from '../components/TransferFooter'
import { useTransferSummary } from '../hooks/useTransferSummary'
import { transferPercent, transferStatusLabels } from '@shared/transfers'
import { NetMergeDialog } from '../components/NetMergeDialog'
import { ArchiveManagerDialog } from '../components/ArchiveManagerDialog'
import { formatFileSize } from '../utils/format'
import {
  ArrowDownToLine,
  CircleAlert,
  Clock3,
  FileArchive,
  FileAudio2,
  FileText,
  FileVideo,
  Gauge,
  Pause,
  Search,
  Trash2,
  XCircle,
  Waypoints
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'

interface ColumnDef {
  id: string
  label: string
  defaultWidth: number
  minWidth: number
}

const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: 'fileName', label: 'File name', defaultWidth: 260, minWidth: 150 },
  { id: 'size', label: 'Size', defaultWidth: 90, minWidth: 65 },
  { id: 'progress', label: 'Progress', defaultWidth: 125, minWidth: 80 },
  { id: 'status', label: 'Status', defaultWidth: 110, minWidth: 75 },
  { id: 'speed', label: 'Speed', defaultWidth: 95, minWidth: 70 },
  { id: 'eta', label: 'Time left', defaultWidth: 85, minWidth: 65 },
  { id: 'type', label: 'Type', defaultWidth: 75, minWidth: 55 },
  { id: 'added', label: 'Added', defaultWidth: 95, minWidth: 70 },
  { id: 'completed', label: 'Completed', defaultWidth: 95, minWidth: 70 }
]

const COLUMNS_STORAGE_KEY = 'fluxfetch-history-column-widths-v2'
const VISIBLE_COLUMNS_STORAGE_KEY = 'fluxfetch-history-visible-columns-v1'

const size = (bytes: number): string => formatFileSize(bytes)
type LibraryEntry = Entry & { torrentId?: string; transferStatus?: string }
const readableActionError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (/\bENOENT\b|no such file or directory/i.test(message))
    return 'This file is no longer at its saved location. It may have been moved or deleted. Download it again to open or preview it.'
  return message.replace(/^Error invoking remote method .*?:\s*/i, '').replace(/^Error:\s*/i, '')
}
const speed = (bytesPerSecond: number): string => {
  if (!bytesPerSecond) return '—'
  const mbps = bytesPerSecond / 1048576
  return `${mbps < 10 ? mbps.toFixed(1) : Math.round(mbps)} MB/s`
}

const calculateEta = (entry: LibraryEntry): string => {
  if (entry.status === 'completed') return 'Done'
  if (['paused', 'error', 'cancelled'].includes(entry.status)) return '—'
  const speedBytes = entry.speedBytesPerSec ?? 0
  if (!speedBytes || speedBytes <= 0 || !entry.totalBytes) return '—'
  const remaining = Math.max(0, entry.totalBytes - entry.bytesDownloaded)
  if (remaining === 0) return '0s'
  const secs = Math.ceil(remaining / speedBytes)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

const getEntryType = (entry: LibraryEntry): string => {
  if (entry.torrentId) return 'Torrent'
  if (entry.category) return entry.category
  const ext = entry.fileName.split('.').pop()?.toUpperCase()
  return ext && ext.length <= 5 ? ext : 'File'
}

const formatEntrySpeed = (entry: LibraryEntry): string => {
  if (['downloading'].includes(entry.status) || (entry.speedBytesPerSec ?? 0) > 0) {
    return speed(entry.speedBytesPerSec ?? 0)
  }
  if (entry.status === 'completed' && entry.avgSpeedBytesPerSec) {
    return `${speed(entry.avgSpeedBytesPerSec)} (avg)`
  }
  return '—'
}

const getEntryProgress = (entry: LibraryEntry): { percent: number; text: string } => {
  if (entry.status === 'completed') return { percent: 100, text: '100%' }
  const pct = transferPercent({
    totalBytes: entry.totalBytes,
    downloadedBytes: entry.bytesDownloaded
  })
  if (pct === null) {
    return {
      percent: 0,
      text: entry.totalBytes ? '0%' : entry.bytesDownloaded > 0 ? size(entry.bytesDownloaded) : '—'
    }
  }
  return { percent: pct, text: `${pct.toFixed(1)}%` }
}
export function HistoryScreen({
  onAdd,
  onQueue,
  onTorrents,
  onSpeedTest,
  onRunOmniLink,
  onRetry
}: {
  onAdd: () => void
  onQueue: () => void
  onTorrents: () => void
  onSpeedTest: () => void
  onRunOmniLink: () => Promise<void>
  onRetry: (url: string) => void
}): React.JSX.Element {
  const [entries, setEntries] = useState(read)
  const [filter, setFilter] = useState('All downloads')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<LibraryEntry | null>(null)
  const summary = useTransferSummary()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [removePrompt, setRemovePrompt] = useState(false)
  const [omniLinkLaunching, setOmniLinkLaunching] = useState(false)
  const [properties, setProperties] = useState(false)
  const [refreshAddress, setRefreshAddress] = useState(false)
  const [replacementUrl, setReplacementUrl] = useState('')
  const [metadataTags, setMetadataTags] = useState('')
  const [metadataCategory, setMetadataCategory] = useState('')
  const [metadataDescription, setMetadataDescription] = useState('')
  const [archiveEntries, setArchiveEntries] = useState<
    Awaited<ReturnType<typeof window.fluxfetch.previewZip>>
  >([])
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(COLUMNS_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      // ignore
    }
    const defaults: Record<string, number> = {}
    for (const c of DEFAULT_COLUMNS) defaults[c.id] = c.defaultWidth
    return defaults
  })
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY)
      if (saved) return JSON.parse(saved)
    } catch {
      // ignore
    }
    const defaults: Record<string, boolean> = {}
    for (const c of DEFAULT_COLUMNS) defaults[c.id] = true
    return defaults
  })
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  const [omniLinkInstalled, setOmniLinkInstalled] = useState(false)
  const [netMergeInstalled, setNetMergeInstalled] = useState(false)

  useEffect(() => {
    if (window.fluxfetch.platform === 'win32') {
      window.fluxfetch
        .isOmniLinkInstalled()
        .then(setOmniLinkInstalled)
        .catch(() => setOmniLinkInstalled(false))
      window.fluxfetch
        .netMergeStatus()
        .then((s) => setNetMergeInstalled(s.installed))
        .catch(() => setNetMergeInstalled(false))
    }
  }, [])

  const toggleColumnVisibility = (colId: string): void => {
    if (colId === 'fileName') return
    setVisibleColumns((prev) => {
      const updated = { ...prev, [colId]: !prev[colId] }
      try {
        localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // ignore
      }
      return updated
    })
  }

  const [resizingCol, setResizingCol] = useState<string | null>(null)

  const handleStartResize = (colId: string, event: React.MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const def = DEFAULT_COLUMNS.find((c) => c.id === colId)
    const startWidth = columnWidths[colId] ?? def?.defaultWidth ?? 100
    const minWidth = def?.minWidth ?? 50
    setResizingCol(colId)

    const onMouseMove = (e: MouseEvent): void => {
      const delta = e.clientX - startX
      const nextWidth = Math.max(minWidth, startWidth + delta)
      setColumnWidths((prev) => {
        const updated = { ...prev, [colId]: nextWidth }
        try {
          localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(updated))
        } catch {
          // ignore
        }
        return updated
      })
    }

    const onMouseUp = (): void => {
      setResizingCol(null)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const handleResetColWidth = (colId: string): void => {
    const def = DEFAULT_COLUMNS.find((c) => c.id === colId)
    if (!def) return
    setColumnWidths((prev) => {
      const updated = { ...prev, [colId]: def.defaultWidth }
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(updated))
      } catch {
        // ignore
      }
      return updated
    })
  }
  const selectDownload = (entry: LibraryEntry | null): void => {
    setSelected(entry)
    setMetadataTags(entry?.tags?.join(', ') ?? '')
    setMetadataCategory(entry?.category ?? '')
    setMetadataDescription(entry?.description ?? '')
  }
  const [error, setError] = useState('')
  useEffect(() => {
    const close = (): void => {
      setMenu(null)
      setHeaderMenu(null)
    }
    const refresh = (): void => setEntries(read())
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener(changedEvent, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener(changedEvent, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  const saveMetadata = (): void => {
    if (!selected) return
    const updated = {
      ...selected,
      tags: metadataTags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 30),
      category: metadataCategory.trim().slice(0, 80),
      description: metadataDescription.trim().slice(0, 500)
    }
    const next = entries.map((entry) => (entry.id === selected.id ? updated : entry))
    localStorage.setItem(key, JSON.stringify(next))
    window.dispatchEvent(new Event(changedEvent))
    setEntries(next)
    selectDownload(updated)
  }
  const previewArchive = async (): Promise<void> => {
    if (!selected) return
    setArchiveBusy(true)
    setError('')
    try {
      const items = await window.fluxfetch.previewZip(selected.destinationPath)
      setArchiveEntries(items)
      setArchiveOpen(true)
    } catch (e) {
      setError(readableActionError(e))
    } finally {
      setArchiveBusy(false)
    }
  }
  const action = async (kind: 'open' | 'folder'): Promise<void> => {
    if (!selected) return
    try {
      await (kind === 'open'
        ? window.fluxfetch.openFile(selected.destinationPath)
        : window.fluxfetch.revealInFolder(selected.destinationPath))
    } catch (e) {
      setError(readableActionError(e))
    }
  }
  const refreshAddressAction = async (): Promise<void> => {
    if (!selected) return
    if (selected.sourcePageUrl) {
      try {
        setProperties(false)
        await window.fluxfetch.openExternalUrl(selected.sourcePageUrl)
        setRefreshAddress(false)
      } catch (e) {
        setError(readableActionError(e))
      }
      return
    }
    setProperties(false)
    setReplacementUrl(selected.url)
    setRefreshAddress(true)
  }
  const liveNormal = new Map(
    summary.items.filter((item) => item.kind === 'normal').map((item) => [item.id, item])
  )
  const library: LibraryEntry[] = entries.map((entry) => {
    const live = liveNormal.get(entry.id)
    return live
      ? {
          ...entry,
          status: live.status as Entry['status'],
          totalBytes: live.totalBytes,
          bytesDownloaded: live.downloadedBytes,
          speedBytesPerSec: live.downloadSpeed
        }
      : entry
  })
  for (const item of summary.items) {
    if (item.kind === 'normal' && library.some((entry) => entry.id === item.id)) continue
    const torrent = item.kind === 'torrent'
    library.push({
      id: torrent ? `torrent:${item.id}` : item.id,
      torrentId: torrent ? item.id : undefined,
      transferStatus: item.status,
      fileName: item.name,
      url: '',
      destinationPath: item.destinationPath ?? '',
      status: torrent
        ? ['complete', 'seeding'].includes(item.status)
          ? 'completed'
          : item.status === 'error'
            ? 'error'
            : item.status === 'paused'
              ? 'paused'
              : 'downloading'
        : (item.status as Entry['status']),
      totalBytes: item.totalBytes,
      bytesDownloaded: item.downloadedBytes,
      startedAt: item.startedAt ?? 0,
      speedBytesPerSec: item.downloadSpeed,
      peakSpeedBytesPerSec: 0,
      avgSpeedBytesPerSec: 0
    })
  }
  library.sort(
    (a, b) =>
      Number(['downloading', 'paused'].includes(b.status)) -
        Number(['downloading', 'paused'].includes(a.status)) || b.startedAt - a.startedAt
  )
  const transferAction = async (
    entry: LibraryEntry,
    action: 'pause' | 'resume' | 'cancel'
  ): Promise<void> => {
    try {
      if (entry.torrentId) {
        if (action === 'pause') await window.fluxfetch.pauseTorrent(entry.torrentId)
        else if (action === 'resume') await window.fluxfetch.resumeTorrent(entry.torrentId)
        else await window.fluxfetch.removeTorrent(entry.torrentId, false)
      } else {
        if (action === 'pause') await window.fluxfetch.pauseDownload(entry.id)
        else if (action === 'resume') await window.fluxfetch.resumeDownload(entry.id)
        else await window.fluxfetch.cancelDownload(entry.id)
      }
    } catch (e) {
      setError(readableActionError(e))
    }
  }
  const rows = library.filter(
    (entry) =>
      `${entry.fileName} ${entry.tags?.join(' ') ?? ''} ${entry.category ?? ''} ${entry.description ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'All downloads' ||
        (filter === 'Finished' && entry.status === 'completed') ||
        (filter === 'Unfinished' && entry.status !== 'completed') ||
        (filter === 'In progress' && entry.status === 'downloading') ||
        (filter === 'Paused' && entry.status === 'paused') ||
        (filter === 'Cancelled' && entry.status === 'cancelled') ||
        (filter === 'Failed' && entry.status === 'error'))
  )
  const selectableRows = rows.filter(
    (entry) => !entry.torrentId && !['downloading', 'paused'].includes(entry.status)
  )
  const allVisibleSelected =
    selectableRows.length > 0 && selectableRows.every((entry) => selectedIds.has(entry.id))
  const toggleEntry = (id: string, checked: boolean): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleVisibleEntries = (checked: boolean): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const entry of selectableRows) {
        if (checked) next.add(entry.id)
        else next.delete(entry.id)
      }
      return next
    })
  }
  const removeSelectedEntries = async (): Promise<void> => {
    const removable = [...selectedIds].filter((id) => {
      const entry = entries.find((item) => item.id === id)
      return entry && !['downloading', 'paused'].includes(entry.status)
    })
    if (!removable.length) return
    await Promise.all(removable.map((id) => window.fluxfetch.removeDownload(id)))
    const next = removeEntries(removable)
    setEntries(next)
    setSelectedIds(new Set())
    if (selected && removable.includes(selected.id)) selectDownload(null)
  }
  const removeSingleEntry = async (deleteFile: boolean): Promise<void> => {
    if (!selected) return
    const entry = selected
    if (entry.torrentId || ['downloading', 'paused'].includes(entry.status)) return
    if (deleteFile) {
      try {
        await window.fluxfetch.trashFile(entry.destinationPath)
      } catch (e) {
        setError(readableActionError(e))
        return
      }
    }
    try {
      await window.fluxfetch.removeDownload(entry.id)
    } catch (e) {
      setError(readableActionError(e))
      return
    }
    const next = removeEntries([entry.id])
    setEntries(next)
    setSelectedIds((current) => {
      const updated = new Set(current)
      updated.delete(entry.id)
      return updated
    })
    selectDownload(null)
    setRemovePrompt(false)
  }
  const launchOmniLink = async (): Promise<void> => {
    setOmniLinkLaunching(true)
    setError('')
    try {
      await onRunOmniLink()
    } catch (e) {
      setError(readableActionError(e))
    } finally {
      setOmniLinkLaunching(false)
    }
  }
  const completedCount = library.filter((entry) => entry.status === 'completed').length
  const activeCount = library.filter((entry) => entry.status === 'downloading').length
  const pausedCount = library.filter((entry) => entry.status === 'paused').length
  const cancelledCount = library.filter((entry) => entry.status === 'cancelled').length
  const failedCount = library.filter((entry) => entry.status === 'error').length
  const fileIcon = (name: string): React.JSX.Element => {
    const extension = name.split('.').pop()?.toLowerCase()
    const Icon = ['zip', '7z', 'rar', 'gz', 'tar'].includes(extension ?? '')
      ? FileArchive
      : ['mp3', 'm4a', 'wav', 'flac'].includes(extension ?? '')
        ? FileAudio2
        : ['mp4', 'mkv', 'mov', 'avi'].includes(extension ?? '')
          ? FileVideo
          : ['pdf', 'doc', 'docx', 'txt'].includes(extension ?? '')
            ? FileText
            : ArrowDownToLine
    return <Icon className="size-4" />
  }
  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden bg-background px-5 pb-3 pt-4 text-foreground sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
            Transfer library
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Downloads</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Your files, ready when you need them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onSpeedTest}>
            <Gauge /> Speed test
          </Button>
          {window.fluxfetch.platform === 'win32' && (
            <Button variant="outline" onClick={onTorrents}>
              <ArrowDownToLine /> Torrents
            </Button>
          )}
          {window.fluxfetch.platform === 'win32' && omniLinkInstalled && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    onClick={() => void launchOmniLink()}
                    disabled={omniLinkLaunching}
                  >
                    <Waypoints /> {omniLinkLaunching ? 'Starting OmniLink…' : 'Run OmniLink'}
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                Windows asks for administrator approval when starting OmniLink. For the best chance
                of combining bandwidth, connect adapters to separate Internet connections—for
                example Ethernet to Router A, Wi-Fi to Router B, and an Android phone USB-tethered
                while it uses Router C. Adapters on the same router share one Internet connection.
                Supports eligible Steam, Epic and other launcher transfers. Use OmniLink&apos;s tray
                menu to add another app. Results depend on download servers, routing and driver
                support affect results, so a speed increase cannot be guaranteed.
              </TooltipContent>
            </Tooltip>
          )}
          {window.fluxfetch.platform === 'win32' && netMergeInstalled && <NetMergeDialog />}
          <Button variant="outline" onClick={onQueue}>
            Queue & schedule
          </Button>
          <Button onClick={onAdd}>+ Add URL</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-6">
        {[
          {
            label: 'In library',
            value: library.length,
            icon: ArrowDownToLine,
            target: 'All downloads'
          },
          { label: 'Completed', value: completedCount, icon: FileText, target: 'Finished' },
          { label: 'In progress', value: activeCount, icon: Clock3, target: 'In progress' },
          { label: 'Paused', value: pausedCount, icon: Pause, target: 'Paused' },
          { label: 'Cancelled', value: cancelledCount, icon: XCircle, target: 'Cancelled' },
          { label: 'Failed', value: failedCount, icon: CircleAlert, target: 'Failed' }
        ].map(({ label, value, icon: Icon, target }) => (
          <button
            type="button"
            key={label}
            aria-label={`${label}: ${value}`}
            aria-pressed={filter === target}
            onClick={() => {
              setFilter(target)
              setSelectedIds(new Set())
            }}
            className={`flex min-w-0 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left shadow-sm transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-primary sm:px-4 ${filter === target ? 'border-primary/60' : 'border-border'}`}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-lg font-semibold leading-5">{value}</div>
              <div className="truncate text-[11px] text-muted-foreground">{label}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 sm:px-4">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-background p-1">
            {[
              'All downloads',
              'Finished',
              'Unfinished',
              'In progress',
              'Paused',
              'Cancelled',
              'Failed'
            ].map((label) => (
              <button
                key={label}
                onClick={() => {
                  setFilter(label)
                  setSelectedIds(new Set())
                }}
                className={`shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${filter === label ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex min-w-40 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:border-primary/70">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              aria-label="Search downloads"
              placeholder="Search files…"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelectedIds(new Set())
              }}
            />
          </label>
        </div>
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <span role="status" className="text-xs text-muted-foreground">
              {selectedIds.size} selected · Files stay on disk
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void removeSelectedEntries().catch((e) => setError(readableActionError(e)))
              }
            >
              <Trash2 /> Remove from history
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[780px] table-fixed text-left text-sm">
            <colgroup>
              <col style={{ width: 40 }} />
              {DEFAULT_COLUMNS.filter((col) => visibleColumns[col.id] !== false).map((col) => (
                <col key={col.id} style={{ width: columnWidths[col.id] ?? col.defaultWidth }} />
              ))}
            </colgroup>
            <thead
              onContextMenu={(e) => {
                e.preventDefault()
                setHeaderMenu({ x: e.clientX, y: e.clientY })
              }}
              className="sticky top-0 z-10 bg-background text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground select-none"
            >
              <tr>
                <th className="border-b border-border px-2 py-2.5 text-center align-middle w-10">
                  <input
                    aria-label="Select all removable downloads"
                    type="checkbox"
                    className="mx-auto block size-4"
                    checked={allVisibleSelected}
                    disabled={selectableRows.length === 0}
                    onChange={(event) => toggleVisibleEntries(event.target.checked)}
                  />
                </th>
                {DEFAULT_COLUMNS.filter((col) => visibleColumns[col.id] !== false).map((col) => (
                  <th
                    key={col.id}
                    title="Right-click to show/hide columns"
                    className="relative border-b border-border px-3 py-2.5 group hover:text-foreground transition-colors overflow-visible"
                  >
                    <div className="flex items-center justify-between min-w-0 pr-1">
                      <span className="truncate">{col.label}</span>
                    </div>
                    {/* Draggable vertical divider handle matching screenshot */}
                    <div
                      onMouseDown={(e) => handleStartResize(col.id, e)}
                      onDoubleClick={() => handleResetColWidth(col.id)}
                      title="Drag to resize column (double-click to reset)"
                      className={`absolute right-0 top-0 bottom-0 w-2.5 cursor-col-resize z-20 flex items-center justify-center transition-colors hover:bg-primary/40 ${
                        resizingCol === col.id ? 'bg-primary/60' : 'bg-transparent'
                      }`}
                    >
                      <div
                        className={`h-4 w-1 rounded-sm transition-colors ${
                          resizingCol === col.id
                            ? 'bg-primary'
                            : 'bg-border/60 group-hover:bg-primary/80'
                        }`}
                      />
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const progress = getEntryProgress(entry)
                return (
                  <tr
                    key={entry.id}
                    data-download-id={entry.id}
                    tabIndex={0}
                    onClick={() => selectDownload(entry)}
                    onDoubleClick={() => {
                      selectDownload(entry)
                      if (entry.torrentId) onTorrents()
                      else if (['downloading', 'paused', 'error'].includes(entry.status)) {
                        void window.fluxfetch
                          .openDownloadWindow(entry.id)
                          .catch((e) => setError(readableActionError(e)))
                      } else if (entry.status === 'completed') {
                        void window.fluxfetch
                          .openFile(entry.destinationPath)
                          .catch((e: unknown) => {
                            setError(readableActionError(e))
                          })
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      selectDownload(entry)
                      setMenu({
                        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
                        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 360))
                      })
                    }}
                    className={`cursor-default border-b border-border/70 transition-colors ${selected?.id === entry.id ? 'bg-primary/10' : 'hover:bg-background/70'}`}
                  >
                    <td className="px-2 py-3 text-center align-middle">
                      <input
                        aria-label={`Select ${entry.fileName}`}
                        type="checkbox"
                        className="mx-auto block size-4"
                        checked={selectedIds.has(entry.id)}
                        disabled={
                          Boolean(entry.torrentId) ||
                          ['downloading', 'paused'].includes(entry.status)
                        }
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => toggleEntry(entry.id, event.target.checked)}
                      />
                    </td>
                    <td className="max-w-72 truncate px-3 py-3" title={entry.fileName}>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                          {fileIcon(entry.fileName)}
                        </span>
                        <span className="truncate font-medium">{entry.fileName}</span>
                      </span>
                      {(['downloading', 'paused'].includes(entry.status) || entry.torrentId) && (
                        <div className="ml-10 mt-2 space-y-1">
                          <div
                            role="progressbar"
                            aria-label={`${entry.fileName} progress`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={
                              transferPercent({
                                totalBytes: entry.totalBytes,
                                downloadedBytes: entry.bytesDownloaded
                              }) ?? undefined
                            }
                            aria-valuetext={
                              entry.totalBytes
                                ? `${((entry.bytesDownloaded / entry.totalBytes) * 100).toFixed(1)}%`
                                : 'Size unknown'
                            }
                            className="h-1.5 overflow-hidden rounded-full bg-muted"
                          >
                            <div
                              className="h-full bg-primary transition-[width]"
                              style={{
                                width: `${transferPercent({ totalBytes: entry.totalBytes, downloadedBytes: entry.bytesDownloaded }) ?? 0}%`
                              }}
                            />
                          </div>
                          <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                            <span>
                              {entry.torrentId ? 'Torrent' : 'Direct'} ·{' '}
                              {size(entry.bytesDownloaded)} / {size(entry.totalBytes)}
                            </span>
                            <span>
                              {entry.totalBytes
                                ? `${((entry.bytesDownloaded / entry.totalBytes) * 100).toFixed(1)}%`
                                : 'Size unknown'}
                            </span>
                            <span>{speed(entry.speedBytesPerSec ?? 0)}</span>
                          </div>
                        </div>
                      )}
                    </td>
                    {visibleColumns.size !== false && (
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
                        {size(entry.totalBytes)}
                      </td>
                    )}
                    {visibleColumns.progress !== false && (
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted shrink-0">
                            <div
                              className="h-full bg-primary transition-[width]"
                              style={{ width: `${progress.percent}%` }}
                            />
                          </div>
                          <span className="tabular-nums">{progress.text}</span>
                        </div>
                      </td>
                    )}
                    {visibleColumns.status !== false && (
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold capitalize ${entry.status === 'completed' ? 'bg-[var(--color-wifi-bg)] text-[var(--color-wifi-text)]' : 'bg-secondary text-muted-foreground'}`}
                        >
                          {entry.transferStatus
                            ? (transferStatusLabels[entry.transferStatus] ?? entry.transferStatus)
                            : entry.status}
                        </span>
                        {['downloading', 'paused', 'error'].includes(entry.status) && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              className="text-xs text-primary hover:underline"
                              aria-label={`${entry.status === 'downloading' ? 'Pause' : 'Resume'} ${entry.fileName}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                void transferAction(
                                  entry,
                                  entry.status === 'downloading' ? 'pause' : 'resume'
                                )
                              }}
                            >
                              {entry.status === 'downloading' ? 'Pause' : 'Resume'}
                            </button>
                            <button
                              className="text-xs text-muted-foreground hover:text-destructive"
                              aria-label={`Cancel ${entry.fileName}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                void transferAction(entry, 'cancel')
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                    {visibleColumns.speed !== false && (
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">
                        {formatEntrySpeed(entry)}
                      </td>
                    )}
                    {visibleColumns.eta !== false && (
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">
                        {calculateEta(entry)}
                      </td>
                    )}
                    {visibleColumns.type !== false && (
                      <td className="whitespace-nowrap px-3 py-3 text-xs">
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-secondary text-secondary-foreground uppercase">
                          {getEntryType(entry)}
                        </span>
                      </td>
                    )}
                    {visibleColumns.added !== false && (
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                        {entry.startedAt ? new Date(entry.startedAt).toLocaleDateString() : '—'}
                      </td>
                    )}
                    {visibleColumns.completed !== false && (
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                        {entry.completedAt ? new Date(entry.completedAt).toLocaleDateString() : '—'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="flex min-h-48 flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <ArrowDownToLine className="size-5" />
              </span>
              <p className="font-medium text-foreground">No downloads here yet</p>
              <p className="mt-1 text-sm">Add a URL or send a download from your browser.</p>
            </div>
          )}
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
        <TransferFooter onTorrents={onTorrents} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span>{rows.length} downloads · Right-click any file for actions</span>
          {entries[0] && (
            <span>
              Last download · Peak {speed(entries[0].peakSpeedBytesPerSec)} · Avg{' '}
              {speed(entries[0].avgSpeedBytesPerSec)}
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </footer>
      {menu && selected?.torrentId && (
        <div
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 w-52 rounded-lg border border-border bg-popover p-1 shadow-xl"
        >
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-secondary"
            onClick={onTorrents}
          >
            Torrent details
          </button>
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-secondary"
            onClick={() =>
              void window.fluxfetch
                .openTorrentFolder(selected.torrentId!)
                .catch((e) => setError(readableActionError(e)))
            }
          >
            Open folder
          </button>
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-secondary"
            onClick={() => void transferAction(selected, 'cancel')}
          >
            Remove torrent (keep files)
          </button>
        </div>
      )}
      {menu && selected && !selected.torrentId && (
        <div
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 max-h-[calc(100dvh-1rem)] w-52 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
        >
          {[
            [
              'Open progress window',
              () =>
                void window.fluxfetch
                  .openDownloadWindow(selected.id)
                  .catch((e: unknown) => setError(readableActionError(e))),
              selected.status === 'completed' || selected.status === 'cancelled'
            ],
            ['Open file', () => void action('open'), selected.status !== 'completed'],
            ['Open folder', () => void action('folder'), false],
            ...(['.zip', '.rar'].some((extension) =>
              selected.fileName.toLowerCase().endsWith(extension)
            )
              ? [
                  [
                    'Preview archive',
                    () => {
                      setMenu(null)
                      void previewArchive()
                    },
                    archiveBusy
                  ]
                ]
              : []),
            ['Refresh Download Address', () => void refreshAddressAction(), false],
            ['Download again', () => onRetry(selected.url), false],
            ['Properties', () => setProperties(true), false],
            [
              'Remove from history',
              () => {
                setMenu(null)
                setRemovePrompt(true)
              },
              ['downloading', 'paused'].includes(selected.status)
            ]
          ].map(([label, callback, disabled]) => (
            <button
              role="menuitem"
              key={String(label)}
              disabled={Boolean(disabled)}
              onClick={callback as () => void}
              className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-secondary disabled:opacity-40"
            >
              {String(label)}
            </button>
          ))}
        </div>
      )}
      {headerMenu && (
        <div
          role="menu"
          aria-label="Customize columns"
          style={{ left: headerMenu.x, top: headerMenu.y }}
          className="fixed z-50 min-w-56 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1.5 shadow-xl select-none"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border/70 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Columns</span>
            <button
              type="button"
              className="text-[11px] font-normal text-primary hover:underline"
              onClick={() => {
                const defaults: Record<string, boolean> = {}
                for (const c of DEFAULT_COLUMNS) defaults[c.id] = true
                setVisibleColumns(defaults)
                try {
                  localStorage.removeItem(VISIBLE_COLUMNS_STORAGE_KEY)
                } catch {
                  // ignore
                }
              }}
            >
              Reset all
            </button>
          </div>
          <div className="mt-1 space-y-0.5">
            {DEFAULT_COLUMNS.map((col) => {
              const isVisible = visibleColumns[col.id] !== false
              const isRequired = col.id === 'fileName'
              return (
                <label
                  key={col.id}
                  className={`flex items-center gap-2.5 rounded px-2.5 py-1.5 text-xs transition-colors ${
                    isRequired
                      ? 'cursor-not-allowed opacity-60 text-muted-foreground'
                      : 'cursor-pointer hover:bg-secondary text-foreground'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isVisible}
                    disabled={isRequired}
                    onChange={() => toggleColumnVisibility(col.id)}
                    className="size-3.5 rounded border-border"
                  />
                  <span className="flex-1 truncate">{col.label}</span>
                  {isRequired && (
                    <span className="text-[10px] text-muted-foreground">(Required)</span>
                  )}
                </label>
              )
            })}
          </div>
        </div>
      )}
      {removePrompt && selected && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4"
          onClick={() => setRemovePrompt(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Remove download"
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold">Remove download?</h2>
            <p className="mt-2 break-words text-sm text-muted-foreground">
              Remove <span className="font-medium text-foreground">{selected.fileName}</span> from
              your download history?
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              You can also move the downloaded file to the Windows Recycle Bin.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setRemovePrompt(false)}>
                Cancel
              </Button>
              <Button variant="outline" onClick={() => void removeSingleEntry(false)}>
                Remove from history
              </Button>
              <Button
                variant="destructive"
                disabled={['downloading', 'paused'].includes(selected.status)}
                onClick={() => void removeSingleEntry(true)}
              >
                Delete file & remove
              </Button>
            </div>
          </section>
        </div>
      )}
      {properties && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setProperties(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Download properties"
            className="mx-6 max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-card p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold">Download properties</h2>
            <dl className="space-y-3 text-sm">
              {Object.entries({
                File: selected.fileName,
                Status: selected.status,
                Size: size(selected.totalBytes),
                Downloaded: size(selected.bytesDownloaded),
                Location: selected.destinationPath,
                URL: selected.url,
                Added: new Date(selected.startedAt).toLocaleString()
              }).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="break-all select-text">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-5 space-y-3 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Download details
              </p>
              <label className="block text-xs text-muted-foreground">
                Category
                <input
                  value={metadataCategory}
                  onChange={(event) => setMetadataCategory(event.target.value)}
                  maxLength={80}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  placeholder="e.g. Work, Games, Courses"
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Tags (comma-separated)
                <input
                  value={metadataTags}
                  onChange={(event) => setMetadataTags(event.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  placeholder="e.g. important, archive"
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Description
                <textarea
                  value={metadataDescription}
                  onChange={(event) => setMetadataDescription(event.target.value)}
                  maxLength={500}
                  rows={3}
                  className="mt-1 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
              <Button variant="outline" onClick={saveMetadata}>
                Save download details
              </Button>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {['.zip', '.rar'].some((extension) =>
                selected.fileName.toLowerCase().endsWith(extension)
              ) && (
                <Button
                  variant="outline"
                  onClick={() => void previewArchive()}
                  disabled={archiveBusy}
                >
                  <FileArchive /> {archiveBusy ? 'Loading…' : 'Preview archive'}
                </Button>
              )}
              <Button
                onClick={() => void action('open')}
                disabled={selected.status !== 'completed'}
              >
                Open file
              </Button>
              <Button variant="outline" onClick={() => void action('folder')}>
                Open file location
              </Button>
              <Button variant="outline" onClick={() => void refreshAddressAction()}>
                Refresh address
              </Button>
              <Button variant="outline" onClick={() => setProperties(false)}>
                Close
              </Button>
            </div>
          </section>
        </div>
      )}
      {refreshAddress && selected && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setRefreshAddress(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Refresh download address"
            className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">Refresh Download Address</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Paste the current direct link for this file. FluxFetch will send it to the download
              form for review before starting.
            </p>
            <label
              className="mt-4 block text-xs uppercase tracking-widest text-muted-foreground"
              htmlFor="refresh-download-url"
            >
              Download address
            </label>
            <input
              id="refresh-download-url"
              type="url"
              value={replacementUrl}
              onChange={(event) => setReplacementUrl(event.target.value)}
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              autoFocus
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRefreshAddress(false)}>
                Cancel
              </Button>
              <Button
                disabled={!/^https?:\/\//i.test(replacementUrl.trim())}
                onClick={() => {
                  const url = replacementUrl.trim()
                  const next = entries.map((entry) =>
                    entry.id === selected.id ? { ...entry, url } : entry
                  )
                  localStorage.setItem(key, JSON.stringify(next))
                  window.dispatchEvent(new Event(changedEvent))
                  setEntries(next)
                  setRefreshAddress(false)
                  onRetry(url)
                }}
              >
                Continue to download
              </Button>
            </div>
          </section>
        </div>
      )}
      {archiveOpen && selected && (
        <ArchiveManagerDialog
          open={archiveOpen}
          archivePath={selected.destinationPath}
          fileName={selected.fileName}
          entries={archiveEntries}
          onClose={() => setArchiveOpen(false)}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  )
}
