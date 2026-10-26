import { useState, useMemo } from 'react'
import type { ArchiveEntryInfo, ArchiveTestResult } from '@shared/types'
import {
  Archive,
  Check,
  CheckSquare,
  CornerLeftUp,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileVideo,
  Folder,
  FolderArchive,
  FolderOpen,
  Info,
  Lock,
  Search,
  ShieldCheck,
  Square,
  X,
  XCircle
} from 'lucide-react'
import { Button } from './ui/button'

interface ArchiveManagerDialogProps {
  open: boolean
  archivePath: string
  fileName: string
  entries: ArchiveEntryInfo[]
  onClose: () => void
  onError: (msg: string) => void
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)} ${units[i]}`
}

function formatDateTime(timestamp?: number): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

function getFileIcon(name: string, isDir: boolean): React.JSX.Element {
  if (isDir) return <Folder className="size-4 shrink-0 text-amber-400" />
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) {
    return <FileArchive className="size-4 shrink-0 text-orange-400" />
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
    return <FileImage className="size-4 shrink-0 text-emerald-400" />
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) {
    return <FileVideo className="size-4 shrink-0 text-violet-400" />
  }
  if (
    ['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'go', 'rs', 'cpp', 'c', 'h'].includes(
      ext
    )
  ) {
    return <FileCode className="size-4 shrink-0 text-sky-400" />
  }
  return <File className="size-4 shrink-0 text-muted-foreground" />
}

export function ArchiveManagerDialog({
  open,
  archivePath,
  fileName,
  entries,
  onClose,
  onError
}: ArchiveManagerDialogProps): React.JSX.Element | null {
  const [currentFolder, setCurrentFolder] = useState<string>('')
  const [selectedNames, setSelectedNames] = useState<Set<string>>(() => new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyMessage, setBusyMessage] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)
  const [testResult, setTestResult] = useState<ArchiveTestResult | null>(null)
  const [successNotice, setSuccessNotice] = useState<string | null>(null)
  const [archivePassword, setArchivePassword] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<((pwd: string) => Promise<void>) | null>(null)

  // Normalize paths and derive folders/files
  const normalizedEntries = useMemo(() => {
    return entries.map((entry) => {
      const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '')
      return {
        ...entry,
        normalizedName
      }
    })
  }, [entries])

  // Items in current view (current directory level or filtered by search)
  const currentViewItems = useMemo(() => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      return normalizedEntries
        .filter((e) => e.normalizedName.toLowerCase().includes(q))
        .map((e) => ({
          displayName: e.normalizedName.split('/').filter(Boolean).pop() || e.normalizedName,
          fullPath: e.normalizedName,
          isDirectory: e.directory,
          size: e.size,
          compressedSize: e.compressedSize,
          time: e.time,
          crc: e.crc,
          encrypted: e.encrypted
        }))
    }

    const prefix = currentFolder ? `${currentFolder.replace(/\/+$/, '')}/` : ''
    const itemMap = new Map<
      string,
      {
        displayName: string
        fullPath: string
        isDirectory: boolean
        size: number
        compressedSize?: number
        time?: number
        crc?: string
        encrypted?: boolean
      }
    >()

    for (const entry of normalizedEntries) {
      if (prefix && !entry.normalizedName.startsWith(prefix)) continue
      const rel = entry.normalizedName.slice(prefix.length)
      if (!rel) continue

      const parts = rel.split('/')
      const firstPart = parts[0]
      if (parts.length > 1 || entry.directory) {
        // It's a folder or inside a folder
        const folderFullPath = `${prefix}${firstPart}/`
        if (!itemMap.has(folderFullPath)) {
          itemMap.set(folderFullPath, {
            displayName: firstPart,
            fullPath: folderFullPath,
            isDirectory: true,
            size: 0,
            compressedSize: 0,
            time: entry.time,
            encrypted: Boolean(entry.encrypted)
          })
        }
        const item = itemMap.get(folderFullPath)!
        item.size += entry.size
        if (entry.compressedSize)
          item.compressedSize = (item.compressedSize ?? 0) + entry.compressedSize
        if (entry.encrypted) item.encrypted = true
      } else {
        // Direct file
        itemMap.set(entry.normalizedName, {
          displayName: firstPart,
          fullPath: entry.normalizedName,
          isDirectory: false,
          size: entry.size,
          compressedSize: entry.compressedSize,
          time: entry.time,
          crc: entry.crc,
          encrypted: Boolean(entry.encrypted)
        })
      }
    }

    // Sort folders first, then alphabetically
    return Array.from(itemMap.values()).sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.displayName.localeCompare(b.displayName, undefined, {
        numeric: true,
        sensitivity: 'base'
      })
    })
  }, [normalizedEntries, currentFolder, searchQuery])

  // Archive statistics
  const stats = useMemo(() => {
    let totalSize = 0
    let totalPacked = 0
    let fileCount = 0
    let folderCount = 0
    for (const e of normalizedEntries) {
      if (e.directory) {
        folderCount++
      } else {
        fileCount++
        totalSize += e.size
        totalPacked += e.compressedSize ?? e.size
      }
    }
    const ratio = totalSize > 0 ? Math.round(((totalSize - totalPacked) / totalSize) * 100) : 0
    return { totalSize, totalPacked, fileCount, folderCount, ratio }
  }, [normalizedEntries])

  // Selected totals
  const selectedStats = useMemo(() => {
    let size = 0
    let count = 0
    for (const e of normalizedEntries) {
      if (selectedNames.has(e.normalizedName)) {
        count++
        size += e.size
      }
    }
    return { count, size }
  }, [normalizedEntries, selectedNames])

  if (!open) return null

  const handleGoUp = (): void => {
    if (!currentFolder) return
    const parts = currentFolder.replace(/\/+$/, '').split('/')
    parts.pop()
    setCurrentFolder(parts.length > 0 ? `${parts.join('/')}/` : '')
    setSelectedNames(new Set())
  }

  const handleOpenFolder = (folderPath: string): void => {
    setCurrentFolder(folderPath)
    setSelectedNames(new Set())
    setSearchQuery('')
  }

  const handleToggleSelectAll = (): void => {
    if (selectedNames.size > 0 && selectedNames.size === currentViewItems.length) {
      setSelectedNames(new Set())
    } else {
      const next = new Set<string>()
      for (const item of currentViewItems) {
        if (!item.isDirectory) next.add(item.fullPath)
      }
      setSelectedNames(next)
    }
  }

  const handleToggleItem = (fullPath: string, isDir: boolean): void => {
    if (isDir) {
      // Toggle all items in that directory
      const inDir = normalizedEntries.filter((e) => e.normalizedName.startsWith(fullPath))
      const allSelected = inDir.every((e) => selectedNames.has(e.normalizedName))
      const next = new Set(selectedNames)
      for (const e of inDir) {
        if (allSelected) next.delete(e.normalizedName)
        else next.add(e.normalizedName)
      }
      setSelectedNames(next)
      return
    }

    const next = new Set(selectedNames)
    if (next.has(fullPath)) next.delete(fullPath)
    else next.add(fullPath)
    setSelectedNames(next)
  }

  const handlePasswordSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!passwordInput) {
      setPasswordError('Please enter a password.')
      return
    }
    const entered = passwordInput
    setArchivePassword(entered)
    setPasswordModalOpen(false)
    setPasswordError(null)
    if (pendingAction) {
      const act = pendingAction
      setPendingAction(null)
      await act(entered)
    }
  }

  const promptPassword = (
    errorMsg: string | null,
    resume: (pwd: string) => Promise<void>
  ): void => {
    setPasswordError(errorMsg)
    setPasswordModalOpen(true)
    setPendingAction(() => resume)
  }

  const handleExtract = async (overridePassword?: string): Promise<void> => {
    const pwd = overridePassword !== undefined ? overridePassword : archivePassword
    const defaultFolder = archivePath.replace(/[\\/][^\\/]+$/, '')
    const destination = await window.fluxfetch.chooseDestinationFolder(defaultFolder)
    if (!destination) return

    const filesToExtract =
      selectedNames.size > 0
        ? Array.from(selectedNames)
        : normalizedEntries.filter((e) => !e.directory).map((e) => e.normalizedName)

    const hasEncrypted = filesToExtract.some((name) => {
      const found = normalizedEntries.find((e) => e.normalizedName === name)
      return found?.encrypted
    })

    if (hasEncrypted && !pwd) {
      promptPassword(null, async (p) => {
        await executeExtract(destination, filesToExtract, p)
      })
      return
    }

    await executeExtract(destination, filesToExtract, pwd)
  }

  const executeExtract = async (
    destination: string,
    filesToExtract: string[],
    pwd: string
  ): Promise<void> => {
    try {
      setBusy(true)
      setBusyMessage('Extracting archive files…')
      setSuccessNotice(null)

      const count = await window.fluxfetch.extractZipEntries(
        archivePath,
        filesToExtract,
        destination,
        pwd || undefined
      )
      setSuccessNotice(
        `Successfully extracted ${count} file${count === 1 ? '' : 's'} to ${destination}`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/password/i.test(msg)) {
        promptPassword(msg, async (p) => {
          await executeExtract(destination, filesToExtract, p)
        })
      } else {
        onError(msg)
      }
    } finally {
      setBusy(false)
      setBusyMessage('')
    }
  }

  const handleTestArchive = async (overridePassword?: string): Promise<void> => {
    const pwd = overridePassword !== undefined ? overridePassword : archivePassword
    try {
      setBusy(true)
      setBusyMessage('Testing archive integrity…')
      setSuccessNotice(null)
      const res = await window.fluxfetch.testArchive(archivePath, pwd || undefined)
      setTestResult(res)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/password/i.test(msg)) {
        promptPassword(msg, async (p) => {
          await handleTestArchive(p)
        })
      } else {
        onError(msg)
      }
    } finally {
      setBusy(false)
      setBusyMessage('')
    }
  }

  const handleOpenFile = async (itemPath: string, overridePassword?: string): Promise<void> => {
    const pwd = overridePassword !== undefined ? overridePassword : archivePassword
    try {
      setBusy(true)
      setBusyMessage('Opening file…')
      await window.fluxfetch.openArchiveEntry(archivePath, itemPath, pwd || undefined)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/password/i.test(msg)) {
        promptPassword(msg, async (p) => {
          await handleOpenFile(itemPath, p)
        })
      } else {
        onError(msg)
      }
    } finally {
      setBusy(false)
      setBusyMessage('')
    }
  }

  const handleViewSelected = async (): Promise<void> => {
    if (selectedNames.size === 0) return
    const first = Array.from(selectedNames)[0]
    await handleOpenFile(first)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`7-Zip Preview - ${fileName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="flex h-[88vh] w-full max-w-5xl flex-col rounded-xl border border-border bg-card shadow-2xl overflow-hidden font-sans">
        {/* Title Bar */}
        <div className="flex items-center justify-between border-b border-border bg-secondary/80 px-4 py-2.5 select-none">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary/20 text-primary">
              <Archive className="size-4" />
            </span>
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-sm tracking-tight text-foreground">
                7-Zip Archive Manager
              </span>
              <span className="text-xs text-muted-foreground truncate max-w-md">— {fileName}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 7-Zip Command Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background px-3 py-2 text-xs">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleExtract()}
            disabled={busy}
            className="h-8 gap-1.5 px-3 font-medium bg-secondary/60 hover:bg-secondary"
          >
            <FolderArchive className="size-3.5 text-primary" />
            Extract {selectedNames.size > 0 ? `(${selectedNames.size})` : 'All'}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleTestArchive()}
            disabled={busy}
            className="h-8 gap-1.5 px-3 font-medium bg-secondary/60 hover:bg-secondary"
          >
            <ShieldCheck className="size-3.5 text-emerald-400" />
            Test Archive
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleViewSelected()}
            disabled={busy || selectedNames.size === 0}
            className="h-8 gap-1.5 px-3 font-medium bg-secondary/60 hover:bg-secondary"
          >
            <ExternalLink className="size-3.5 text-sky-400" />
            View / Open
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setInfoOpen(true)}
            className="h-8 gap-1.5 px-3 font-medium bg-secondary/60 hover:bg-secondary"
          >
            <Info className="size-3.5 text-amber-400" />
            Properties
          </Button>

          <div className="h-5 w-px bg-border mx-1" />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleToggleSelectAll}
            className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
          >
            {selectedNames.size > 0 && selectedNames.size === currentViewItems.length ? (
              <>
                <Square className="size-3.5" /> Deselect All
              </>
            ) : (
              <>
                <CheckSquare className="size-3.5" /> Select All
              </>
            )}
          </Button>
        </div>

        {/* Address / Navigation Bar */}
        <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-xs">
          <button
            type="button"
            disabled={!currentFolder}
            onClick={handleGoUp}
            className="flex size-7 items-center justify-center rounded border border-border bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
            title="Up one level (..)"
          >
            <CornerLeftUp className="size-3.5" />
          </button>

          <div className="flex flex-1 items-center gap-1.5 rounded border border-border bg-background px-2.5 py-1 text-xs">
            <span className="font-mono text-muted-foreground">{fileName}\</span>
            <span className="font-mono text-foreground font-medium truncate">
              {currentFolder ? currentFolder.replace(/\//g, '\\') : ''}
            </span>
          </div>

          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search in archive…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded border border-border bg-background py-1 pl-8 pr-2.5 text-xs placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Notice Banners */}
        {busy && (
          <div className="flex items-center gap-2 bg-primary/10 border-b border-primary/20 px-4 py-2 text-xs text-primary animate-pulse">
            <div className="size-2 rounded-full bg-primary animate-ping" />
            <span>{busyMessage}</span>
          </div>
        )}
        {successNotice && (
          <div className="flex items-center justify-between bg-emerald-500/10 border-b border-emerald-500/20 px-4 py-2 text-xs text-emerald-400">
            <div className="flex items-center gap-2">
              <Check className="size-4" />
              <span>{successNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => setSuccessNotice(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* 7-Zip File List View */}
        <div className="min-h-0 flex-1 overflow-auto bg-background/50 select-none">
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col className="w-10" />
              <col className="w-[45%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-[15%]" />
              <col className="w-[10%]" />
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-border bg-secondary text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-center align-middle">
                  <input
                    type="checkbox"
                    checked={
                      currentViewItems.length > 0 && selectedNames.size === currentViewItems.length
                    }
                    onChange={handleToggleSelectAll}
                    className="size-3.5 mx-auto block"
                  />
                </th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Packed Size</th>
                <th className="px-3 py-2">Modified</th>
                <th className="px-3 py-2">CRC</th>
              </tr>
            </thead>
            <tbody>
              {/* Up directory row when inside a folder */}
              {currentFolder && !searchQuery && (
                <tr
                  onDoubleClick={handleGoUp}
                  className="cursor-pointer border-b border-border/40 hover:bg-secondary/60 text-muted-foreground"
                >
                  <td className="px-2 py-1.5 text-center" />
                  <td className="px-3 py-1.5 font-medium flex items-center gap-2 text-foreground">
                    <FolderOpen className="size-4 text-amber-400" />
                    <span>..</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono">—</td>
                  <td className="px-3 py-1.5 font-mono">—</td>
                  <td className="px-3 py-1.5">—</td>
                  <td className="px-3 py-1.5 font-mono">—</td>
                </tr>
              )}

              {currentViewItems.map((item) => {
                const isSelected = selectedNames.has(item.fullPath)
                return (
                  <tr
                    key={item.fullPath}
                    onClick={() => handleToggleItem(item.fullPath, item.isDirectory)}
                    onDoubleClick={() => {
                      if (item.isDirectory) {
                        handleOpenFolder(item.fullPath)
                      } else {
                        void handleOpenFile(item.fullPath)
                      }
                    }}
                    className={`cursor-pointer border-b border-border/40 transition-colors ${
                      isSelected ? 'bg-primary/15' : 'hover:bg-secondary/40'
                    }`}
                  >
                    <td
                      className="px-2 py-1.5 text-center align-middle"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggleItem(item.fullPath, item.isDirectory)}
                        className="size-3.5 mx-auto block"
                      />
                    </td>
                    <td className="truncate px-3 py-1.5 font-medium" title={item.displayName}>
                      <span className="flex items-center gap-2 min-w-0">
                        {getFileIcon(item.displayName, item.isDirectory)}
                        <span className="truncate">{item.displayName}</span>
                        {item.encrypted && (
                          <span title="Password-protected entry">
                            <Lock className="size-3 shrink-0 text-amber-400" />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">
                      {item.isDirectory ? '—' : formatBytes(item.size)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">
                      {item.compressedSize ? formatBytes(item.compressedSize) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                      {formatDateTime(item.time)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground uppercase text-[11px]">
                      {item.crc || '—'}
                    </td>
                  </tr>
                )
              })}

              {currentViewItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-sm text-muted-foreground">
                    {searchQuery ? 'No matching items found.' : 'This folder is empty.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 7-Zip Classic Status Bar */}
        <div className="flex items-center justify-between border-t border-border bg-secondary/70 px-4 py-2 text-[11px] text-muted-foreground select-none">
          <div className="flex items-center gap-3">
            <span>
              {selectedStats.count > 0 ? (
                <span className="text-foreground font-medium">
                  {selectedStats.count} object(s) selected ({formatBytes(selectedStats.size)})
                </span>
              ) : (
                '0 object(s) selected'
              )}
            </span>
          </div>

          <div className="flex items-center gap-4 font-mono text-[10.5px]">
            <span>
              Total: {stats.fileCount} file{stats.fileCount === 1 ? '' : 's'}, {stats.folderCount}{' '}
              folder
              {stats.folderCount === 1 ? '' : 's'}
            </span>
            <span>
              Size: {formatBytes(stats.totalSize)} (Packed: {formatBytes(stats.totalPacked)})
            </span>
            <span>Ratio: {stats.ratio}%</span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-4 py-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            type="button"
            onClick={() => void handleExtract()}
            disabled={busy}
            className="gap-1.5 font-medium"
          >
            <FolderArchive className="size-4" />
            {selectedNames.size > 0 ? `Extract Selected (${selectedNames.size})` : 'Extract All'}
          </Button>
        </div>
      </div>

      {/* Password Prompt Modal */}
      {passwordModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4"
        >
          <form
            onSubmit={(e) => void handlePasswordSubmit(e)}
            className="flex w-full max-w-sm flex-col rounded-xl border border-border bg-card p-5 shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-border pb-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
                <Lock className="size-5" />
              </div>
              <div>
                <h3 className="font-semibold text-base">Password Required</h3>
                <p className="text-xs text-muted-foreground">
                  Enter password to extract or view encrypted files
                </p>
              </div>
            </div>

            <div className="my-4 space-y-2">
              <label className="text-xs font-medium text-foreground">Archive Password</label>
              <div className="relative flex items-center">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoFocus
                  value={passwordInput}
                  onChange={(e) => {
                    setPasswordInput(e.target.value)
                    setPasswordError(null)
                  }}
                  placeholder="Enter archive password"
                  className="w-full rounded-md border border-input bg-background pr-9 pl-3 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none font-mono"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {passwordError && (
                <p className="text-xs text-destructive">{passwordError}</p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-border/50">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setPasswordModalOpen(false)
                  setPasswordError(null)
                  setPendingAction(null)
                }}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Unlock & Extract
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* 7-Zip Archive Properties Modal */}
      {infoOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="font-semibold text-base flex items-center gap-2">
                <Info className="size-4 text-amber-400" />
                Archive Properties
              </h3>
              <button
                type="button"
                onClick={() => setInfoOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="my-4 space-y-2.5 text-xs">
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Archive Name:</span>
                <span className="font-medium text-foreground truncate max-w-xs">{fileName}</span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Path:</span>
                <span className="font-mono text-foreground truncate max-w-xs" title={archivePath}>
                  {archivePath}
                </span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Format:</span>
                <span className="font-medium text-foreground uppercase">
                  {fileName.split('.').pop() ?? 'Archive'}
                </span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Files:</span>
                <span className="font-mono text-foreground">{stats.fileCount}</span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Folders:</span>
                <span className="font-mono text-foreground">{stats.folderCount}</span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Unpacked Size:</span>
                <span className="font-mono text-foreground">
                  {formatBytes(stats.totalSize)} ({stats.totalSize.toLocaleString()} bytes)
                </span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Packed Size:</span>
                <span className="font-mono text-foreground">
                  {formatBytes(stats.totalPacked)} ({stats.totalPacked.toLocaleString()} bytes)
                </span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Compression Ratio:</span>
                <span className="font-mono text-foreground">{stats.ratio}%</span>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <Button type="button" onClick={() => setInfoOpen(false)}>
                OK
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 7-Zip Test Result Modal */}
      {testResult && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="flex w-full max-w-md flex-col rounded-xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-border pb-3">
              {testResult.ok ? (
                <div className="flex size-10 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                  <ShieldCheck className="size-6" />
                </div>
              ) : (
                <div className="flex size-10 items-center justify-center rounded-full bg-destructive/20 text-destructive">
                  <XCircle className="size-6" />
                </div>
              )}
              <div>
                <h3 className="font-semibold text-base">
                  {testResult.ok ? 'Archive Test Succeeded' : 'Archive Test Failed'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {testResult.ok
                    ? 'Everything is OK. No errors were detected.'
                    : `${testResult.errors.length} error(s) detected during test.`}
                </p>
              </div>
            </div>
            <div className="my-4 space-y-2 text-xs">
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Tested Files:</span>
                <span className="font-mono font-medium">{testResult.totalFiles}</span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground">Tested Bytes:</span>
                <span className="font-mono font-medium">{formatBytes(testResult.totalBytes)}</span>
              </div>
              {testResult.errors.length > 0 && (
                <div className="mt-2 max-h-36 overflow-auto rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive font-mono text-[11px]">
                  {testResult.errors.map((e, idx) => (
                    <div key={idx}>{e}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end pt-2">
              <Button type="button" onClick={() => setTestResult(null)}>
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
