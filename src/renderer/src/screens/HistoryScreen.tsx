import { useEffect, useState } from 'react'
import { read, key, changedEvent, removeEntries, type Entry } from '../history'
import { Button } from '../components/ui/button'
import {
  ArrowDownToLine,
  Clock3,
  FileArchive,
  FileAudio2,
  FileText,
  FileVideo,
  Gauge,
  Search,
  Trash2,
  Waypoints
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'

const size = (bytes: number): string => (bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '—')
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
export function HistoryScreen({
  onAdd,
  onQueue,
  onSpeedTest,
  onRunOmniLink,
  onRetry
}: {
  onAdd: () => void
  onQueue: () => void
  onSpeedTest: () => void
  onRunOmniLink: () => Promise<void>
  onRetry: (url: string) => void
}): React.JSX.Element {
  const [entries, setEntries] = useState(read)
  const [filter, setFilter] = useState('All downloads')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Entry | null>(null)
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
    Awaited<ReturnType<typeof window.plexo.previewZip>>
  >([])
  const [archiveSelection, setArchiveSelection] = useState<string[]>([])
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const selectDownload = (entry: Entry | null): void => {
    setSelected(entry)
    setMetadataTags(entry?.tags?.join(', ') ?? '')
    setMetadataCategory(entry?.category ?? '')
    setMetadataDescription(entry?.description ?? '')
  }
  const [error, setError] = useState('')
  useEffect(() => {
    const close = (): void => setMenu(null)
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
      const items = await window.plexo.previewZip(selected.destinationPath)
      setArchiveEntries(items)
      setArchiveSelection([])
      setArchiveOpen(true)
    } catch (e) {
      setError(readableActionError(e))
    } finally {
      setArchiveBusy(false)
    }
  }
  const extractArchiveSelection = async (): Promise<void> => {
    if (!selected || archiveSelection.length === 0) return
    const defaultFolder = selected.destinationPath.replace(/[\\/][^\\/]+$/, '')
    const destination = await window.plexo.chooseDestinationFolder(defaultFolder)
    if (!destination) return
    setArchiveBusy(true)
    try {
      const count = await window.plexo.extractZipEntries(
        selected.destinationPath,
        archiveSelection,
        destination
      )
      setArchiveOpen(false)
      setError(`Extracted ${count} file${count === 1 ? '' : 's'} to ${destination}`)
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
        ? window.plexo.openFile(selected.destinationPath)
        : window.plexo.revealInFolder(selected.destinationPath))
    } catch (e) {
      setError(readableActionError(e))
    }
  }
  const refreshAddressAction = async (): Promise<void> => {
    if (!selected) return
    if (selected.sourcePageUrl) {
      try {
        setProperties(false)
        await window.plexo.openExternalUrl(selected.sourcePageUrl)
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
  const rows = entries.filter(
    (entry) =>
      `${entry.fileName} ${entry.tags?.join(' ') ?? ''} ${entry.category ?? ''} ${entry.description ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'All downloads' ||
        (filter === 'Finished' ? entry.status === 'completed' : entry.status !== 'completed'))
  )
  const selectableRows = rows.filter((entry) => !['downloading', 'paused'].includes(entry.status))
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
  const removeSelectedEntries = (): void => {
    const removable = [...selectedIds].filter((id) => {
      const entry = entries.find((item) => item.id === id)
      return entry && !['downloading', 'paused'].includes(entry.status)
    })
    if (!removable.length) return
    const next = removeEntries(removable)
    setEntries(next)
    setSelectedIds(new Set())
    if (selected && removable.includes(selected.id)) selectDownload(null)
  }
  const removeSingleEntry = async (deleteFile: boolean): Promise<void> => {
    if (!selected) return
    const entry = selected
    if (deleteFile) {
      try {
        await window.plexo.trashFile(entry.destinationPath)
      } catch (e) {
        setError(readableActionError(e))
        return
      }
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
  const completedCount = entries.filter((entry) => entry.status === 'completed').length
  const activeCount = entries.filter((entry) => entry.status !== 'completed').length
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
          {window.plexo.platform === 'win32' && (
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
                Launches OmniLink with Windows administrator approval. It attempts to route
                Steam&apos;s web downloads across your active network adapters; results depend on
                your networks and Steam&apos;s download servers.
              </TooltipContent>
            </Tooltip>
          )}
          <Button variant="outline" onClick={onQueue}>
            Queue & schedule
          </Button>
          <Button onClick={onAdd}>+ Add URL</Button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[
          { label: 'In library', value: entries.length, icon: ArrowDownToLine },
          { label: 'Completed', value: completedCount, icon: FileText },
          { label: 'In progress', value: activeCount, icon: Clock3 }
        ].map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm sm:px-4"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-lg font-semibold leading-5">{value}</div>
              <div className="truncate text-[11px] text-muted-foreground">{label}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-1 rounded-lg bg-background p-1">
            {['All downloads', 'Finished', 'Unfinished'].map((label) => (
              <button
                key={label}
                onClick={() => {
                  setFilter(label)
                  setSelectedIds(new Set())
                }}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${filter === label ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
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
            <Button variant="outline" size="sm" onClick={removeSelectedEntries}>
              <Trash2 /> Remove from history
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[560px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-10" />
              <col className="w-[42%]" />
              <col className="w-[18%]" />
              <col className="w-[17%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead className="sticky top-0 bg-background text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <tr>
                <th className="border-b border-border px-2 py-2.5">
                  <input
                    aria-label="Select all removable downloads"
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={selectableRows.length === 0}
                    onChange={(event) => toggleVisibleEntries(event.target.checked)}
                  />
                </th>
                {['File name', 'Size', 'Status', 'Added'].map((label) => (
                  <th className="border-b border-border px-3 py-2.5" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr
                  key={entry.id}
                  tabIndex={0}
                  onClick={() => selectDownload(entry)}
                  onDoubleClick={() => {
                    selectDownload(entry)
                    if (entry.status === 'completed') {
                      void window.plexo.openFile(entry.destinationPath).catch((e: unknown) => {
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
                  <td className="px-2 py-3 text-center">
                    <input
                      aria-label={`Select ${entry.fileName}`}
                      type="checkbox"
                      checked={selectedIds.has(entry.id)}
                      disabled={['downloading', 'paused'].includes(entry.status)}
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
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
                    {size(entry.totalBytes)}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold capitalize ${entry.status === 'completed' ? 'bg-[var(--color-wifi-bg)] text-[var(--color-wifi-text)]' : 'bg-secondary text-muted-foreground'}`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {new Date(entry.startedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
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
      {menu && selected && (
        <div
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 max-h-[calc(100dvh-1rem)] w-52 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
        >
          {[
            [
              'Open progress window',
              () =>
                void window.plexo
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
              false
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
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Archive contents"
            className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border bg-card p-5 shadow-2xl"
          >
            <h2 className="text-lg font-semibold">Archive contents</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Select files to extract. Unsafe paths and files over 256 MB are blocked.
            </p>
            <div className="my-4 min-h-0 flex-1 overflow-auto rounded-lg border border-border">
              {archiveEntries.map((entry) => (
                <label
                  key={entry.name}
                  className="flex items-center gap-3 border-b border-border/70 px-3 py-2 text-sm last:border-0"
                >
                  <input
                    type="checkbox"
                    disabled={entry.directory}
                    checked={archiveSelection.includes(entry.name)}
                    onChange={(event) =>
                      setArchiveSelection((previous) =>
                        event.target.checked
                          ? [...previous, entry.name]
                          : previous.filter((name) => name !== entry.name)
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 break-all">
                    {entry.name}
                    {entry.directory ? '/' : ''}
                  </span>
                  {!entry.directory && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {size(entry.size)}
                    </span>
                  )}
                </label>
              ))}
              {archiveEntries.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">This ZIP is empty.</p>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setArchiveOpen(false)}>
                Close
              </Button>
              <Button
                onClick={() => void extractArchiveSelection()}
                disabled={archiveBusy || archiveSelection.length === 0}
              >
                {archiveBusy ? 'Extracting…' : `Extract selected (${archiveSelection.length})`}
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
