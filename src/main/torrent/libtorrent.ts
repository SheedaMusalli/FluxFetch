import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { join, isAbsolute, resolve, relative, sep } from 'node:path'
import { app, shell, type BrowserWindow } from 'electron'
import type { TorrentTransfer } from '../../shared/torrent'
import { IpcChannels } from '../../shared/ipc-channels'

const MAX_METAINFO = 10 * 1024 * 1024

export class TorrentManager {
  private child: ChildProcessWithoutNullStreams | null = null
  private started: Promise<void> | null = null
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private timer: NodeJS.Timeout | null = null
  private refreshing = false
  private stderr = ''
  private progressSnapshot: TorrentTransfer[] = []

  getProgressSnapshot(): readonly TorrentTransfer[] {
    return this.progressSnapshot
  }

  constructor(private readonly windows: () => BrowserWindow[]) {}

  async start(): Promise<void> {
    if (this.started) return this.started
    this.started = this.launch().catch((error) => {
      this.started = null
      throw error
    })
    return this.started
  }

  private async launch(): Promise<void> {
    if (process.platform !== 'win32')
      throw new Error('The bundled torrent engine currently supports Windows x64.')
    const root = app.isPackaged
      ? join(process.resourcesPath, 'torrent')
      : join(app.getAppPath(), 'resources/torrent-engine')
    const data = join(app.getPath('userData'), 'torrent-session')
    await mkdir(data, { recursive: true })
    this.stderr = ''
    const child = spawn(
      join(root, 'runtime/python.exe'),
      ['-I', '-u', join(root, 'engine.py'), data],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    this.child = child
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 64 * 1024 * 1024) {
        child.kill()
        return
      }
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        try {
          const response = JSON.parse(line) as { id: number; result?: unknown; error?: string }
          const waiter = this.pending.get(response.id)
          if (!waiter) continue
          this.pending.delete(response.id)
          clearTimeout(waiter.timer)
          if (response.error) waiter.reject(new Error(response.error))
          else waiter.resolve(response.result)
        } catch {
          this.stderr = `Invalid response from torrent engine. ${line.slice(0, 200)}`
        }
      }
    })
    child.stderr.on('data', (bytes: Buffer) => {
      this.stderr = (this.stderr + bytes.toString()).slice(-4000)
    })
    const fail = (error: Error): void => {
      if (this.child !== child) return
      this.child = null
      this.progressSnapshot = this.progressSnapshot.map((item) => ({
        ...item,
        status: 'error',
        downloadSpeed: 0,
        uploadSpeed: 0,
        error: error.message
      }))
      this.started = null
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
      this.pending.clear()
    }
    child.once('error', (error) =>
      fail(new Error(`Torrent engine could not start: ${error.message}`))
    )
    child.once('exit', (code) =>
      fail(new Error(`Torrent engine stopped (${code ?? 'signal'}). ${this.stderr}`))
    )
    child.stdin.on('error', (error) =>
      fail(new Error(`Torrent engine connection closed: ${error.message}`))
    )
    await this.request('ping', {})
    this.timer = setInterval(() => void this.refresh(), 1000)
    this.timer.unref()
  }

  private request<T>(method: string, params: object): Promise<T> {
    const child = this.child
    if (!child || child.killed) return Promise.reject(new Error('Torrent engine is not running.'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Torrent engine timed out: ${method}. ${this.stderr}`))
      }, 30_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  async add(source: string, destinationDir: string, maxDownloadSpeed = 0): Promise<void> {
    await this.start()
    if (/^magnet:/i.test(source)) {
      const parsed = new URL(source)
      const valid = parsed.searchParams
        .getAll('xt')
        .some((xt) =>
          /^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$|^urn:btmh:1220[a-f\d]{64}$/i.test(xt)
        )
      if (!valid) throw new Error('This magnet link has no valid torrent identifier.')
      await this.request('add', {
        source: parsed.href,
        destination: destinationDir,
        limit: maxDownloadSpeed
      })
    } else {
      const parsed = new URL(source)
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        !parsed.pathname.toLowerCase().endsWith('.torrent')
      )
        throw new Error('Use a magnet link or a direct .torrent URL.')
      const response = await fetch(parsed.href, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok || !response.body)
        throw new Error(`Could not fetch torrent metadata (${response.status}).`)
      const chunks: Buffer[] = []
      let count = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          count += value.length
          if (count > MAX_METAINFO) throw new Error('Torrent metadata exceeds 10 MB.')
          chunks.push(Buffer.from(value))
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      await this.addBytes(Buffer.concat(chunks), destinationDir, maxDownloadSpeed)
    }
    await this.refresh()
    this.announceAdded()
  }

  private async addBytes(bytes: Buffer, destination: string, limit: number): Promise<void> {
    if (!bytes.length || bytes.length > MAX_METAINFO)
      throw new Error('Torrent metadata must be between 1 byte and 10 MB.')
    await this.request('add', { data: bytes.toString('base64'), destination, limit })
  }

  async addFile(path: string, destinationDir: string, maxDownloadSpeed = 0): Promise<void> {
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.torrent'))
      throw new Error('Choose a local .torrent file.')
    await this.start()
    await this.addBytes(await readFile(path), destinationDir, maxDownloadSpeed)
    await this.refresh()
    this.announceAdded()
  }

  async list(): Promise<TorrentTransfer[]> {
    await this.start()
    this.progressSnapshot = await this.request('list', {})
    return this.progressSnapshot
  }
  private async action(method: string, gid: string, extra: object = {}): Promise<void> {
    if (!/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(gid)) throw new Error('Invalid torrent identifier.')
    await this.start()
    await this.request(method, { gid, ...extra })
    await this.refresh()
  }
  async pause(gid: string): Promise<void> {
    await this.action('pause', gid)
  }
  async resume(gid: string): Promise<void> {
    await this.action('resume', gid)
  }
  async reannounce(gid: string): Promise<void> {
    await this.action('reannounce', gid)
  }
  async openFolder(gid: string): Promise<void> {
    const torrent = (await this.list()).find((item) => item.gid === gid)
    if (!torrent) throw new Error('That torrent is no longer in the list.')
    const base = resolve(torrent.destinationDir)
    let folder = resolve(torrent.contentDirectory || base)
    const child = relative(base, folder)
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
      throw new Error('Torrent folder is outside its download destination.')
    try {
      if (!(await stat(folder)).isDirectory()) folder = base
    } catch {
      folder = base
    }
    const error = await shell.openPath(folder)
    if (error) throw new Error(`Could not open download folder: ${error}`)
  }
  async remove(gid: string, deleteFiles: boolean): Promise<void> {
    await this.action('remove', gid, { deleteFiles })
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || !this.child) return
    this.refreshing = true
    try {
      const transfers = await this.request<TorrentTransfer[]>('list', {})
      this.progressSnapshot = transfers
      for (const window of this.windows())
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.torrentsUpdated, transfers)
    } catch (error) {
      console.error('[torrent]', error)
    } finally {
      this.refreshing = false
    }
  }

  private announceAdded(): void {
    for (const window of this.windows())
      if (!window.isDestroyed()) window.webContents.send(IpcChannels.torrentAdded)
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const child = this.child
    if (!child) return
    await this.request('shutdown', {}).catch(() => {})
    child.stdin.end()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve()
        return
      }
      const timeout = setTimeout(() => {
        child.kill()
        resolve()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.child = null
    this.started = null
  }
}
