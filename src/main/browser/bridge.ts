import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { DownloadManager } from '../download/downloadManager'
import { probeUrl } from '../download/probe'
import { listActiveInterfaces } from '../network/interfaces'
import { loadSettings } from '../settings'
import { getDefaultTemporaryDir, getSuggestedDownloadDir } from '../download/paths'
import { browserHeaders, httpUrl, type BrowserContext } from './headers'
import type { DownloadConfirmationResponse, ProbeResult } from '../../shared/types'
import { testKnobs } from '../testKnobs'
import { YoutubeDownloads } from './youtube'
import type { TorrentManager } from '../torrent/libtorrent'
import { siteAuthContext } from '../siteAuth'

interface Entry {
  id: string
  url: string
  sourcePageUrl?: string
  filename: string
  context: BrowserContext
  error?: string
  downloadId?: string
  probe?: ProbeResult
  probedAt?: number
  destinationDir?: string
  temporaryDir?: string
}

async function checkFile(
  url: string,
  context: BrowserContext,
  userAgent?: string
): Promise<ProbeResult> {
  const savedAuth = await siteAuthContext(url)
  const combinedContext =
    savedAuth && context?.origin === savedAuth.origin
      ? { ...savedAuth, headers: { ...savedAuth.headers, ...context.headers } }
      : context || savedAuth
  const probe = await probeUrl(url, combinedContext, userAgent)
  if (/text\/html|application\/xhtml/i.test(probe.contentType ?? '')) {
    throw new Error(
      'The server returned a web page or sign-in challenge. Use the website’s original Download button.'
    )
  }
  if (/mpegurl|dash\+xml/i.test(probe.contentType ?? '')) {
    throw new Error('This is a segmented streaming playlist, not a standalone file.')
  }
  return probe
}

function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  const MB = 1024 * 1024
  const GB = 1024 * MB
  if (bytes > 1023 * MB) {
    const val = bytes / GB
    return `${val >= 10 ? val.toFixed(1) : val.toFixed(2)} GB`
  }
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${bytes} B`
}

/** A local named pipe, never an HTTP server accessible to websites. */
export async function startBrowserBridge(
  manager: DownloadManager,
  show: () => void,
  torrents: TorrentManager
): Promise<Server> {
  const confirmDownload = async (
    fileName: string,
    details: string
  ): Promise<DownloadConfirmationResponse> => {
    if (testKnobs.userDataDir) return { accepted: true }
    show()
    return manager.confirmExternalDownload(fileName, details)
  }
  const youtube = new YoutubeDownloads(manager, show, confirmDownload)
  const suffix =
    testKnobs.browserPipe ||
    createHash('sha256').update(app.getPath('home').toLowerCase()).digest('hex').slice(0, 16)
  const pipe = `\\\\.\\pipe\\fluxfetch-browser-${suffix}`
  const queuePath = join(app.getPath('userData'), 'browser-queue.bin')
  let entries: Entry[] = []
  try {
    entries = JSON.parse(safeStorage.decryptString(await readFile(queuePath)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Could not restore browser queue', error)
  }
  async function save(): Promise<void> {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Windows credential encryption unavailable')
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(`${queuePath}.tmp`, safeStorage.encryptString(JSON.stringify(entries)))
    await rename(`${queuePath}.tmp`, queuePath)
  }
  // One transaction at a time, including scheduler ticks and multiple browser windows.
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn)
    chain = result.catch(() => {})
    return result
  }
  async function tick(): Promise<void> {
    const downloads = await manager.listDownloads()
    // Recover a crash between the manager committing the download and the queue saving its ID.
    let changed = false
    for (const download of downloads) {
      const adopted = entries.find((entry) => entry.id === download.state.browserRequestId)
      if (adopted && !adopted.downloadId) {
        adopted.downloadId = download.state.id
        changed = true
      }
    }
    const remaining = entries.filter(
      (entry) =>
        !entry.downloadId ||
        downloads.some(
          (download) =>
            download.state.id === entry.downloadId &&
            ['downloading', 'paused', 'error'].includes(download.state.status)
        )
    )
    if (remaining.length !== entries.length) changed = true
    entries = remaining
    if (changed) await save()
    // Media transfers retain their own browser confirmation and processing sequence.
    if (youtube.isBusy()) return
    const next = entries.find((entry) => !entry.error && !entry.downloadId)
    if (!next) return
    try {
      const probe =
        next.probe && Date.now() - (next.probedAt || 0) < 30000
          ? next.probe
          : await checkFile(next.url, next.context, (await loadSettings()).customUserAgent)
      const settings = await loadSettings()
      const baseDir = settings.destinationDir || app.getPath('downloads')
      next.downloadId = await manager.start({
        browserRequestId: next.id,
        url: probe.finalUrl,
        destinationDir:
          next.destinationDir ||
          getSuggestedDownloadDir(baseDir, next.filename || probe.suggestedFileName),
        temporaryDir: next.temporaryDir || getDefaultTemporaryDir(),
        suggestedFileName: next.filename || probe.suggestedFileName,
        totalBytes: probe.totalBytes ?? 0,
        supportsRanges: probe.supportsRanges,
        interfaceIds: (await listActiveInterfaces()).map((network) => network.id),
        etag: probe.etag,
        lastModified: probe.lastModified,
        browserContext: next.context,
        sourcePageUrl: next.sourcePageUrl
      })
      show()
    } catch (error) {
      next.error = error instanceof Error ? error.message : 'Download could not start'
    }
    await save()
  }
  async function dispatch(
    message: Record<string, unknown>,
    isConnected: () => boolean
  ): Promise<unknown> {
    if (String(message.action).startsWith('youtube')) return youtube.dispatch(message)
    if (message.action === 'torrent') {
      let torrentUrl: URL
      try {
        torrentUrl = new URL(String(message.url || ''))
      } catch {
        throw new Error('That torrent address is invalid.')
      }
      const isMagnet = torrentUrl.protocol === 'magnet:'
      const isTorrentUrl =
        ['http:', 'https:'].includes(torrentUrl.protocol) && /\.torrent$/i.test(torrentUrl.pathname)
      if ((!isMagnet && !isTorrentUrl) || torrentUrl.username || torrentUrl.password)
        throw new Error('Only magnet links and direct .torrent links are supported.')
      const name = isMagnet
        ? torrentUrl.searchParams.get('dn') || 'Magnet torrent'
        : decodeURIComponent(torrentUrl.pathname.split('/').pop() || 'Torrent download')
      const confirmation = await confirmDownload(
        name,
        `Torrent · ${isMagnet ? 'magnet link' : torrentUrl.origin}`
      )
      if (!confirmation.accepted) return { ok: true, cancelled: true }
      const torrentSettings = await loadSettings()
      await torrents.add(
        torrentUrl.href,
        confirmation.destinationDir || torrentSettings.destinationDir || app.getPath('downloads'),
        torrentSettings.maxDownloadSpeedBytesPerSec ?? 0
      )
      show()
      return { ok: true, added: true }
    }
    if (message.action === 'status') {
      const current = await manager.getCurrentDownload()
      return {
        ok: true,
        version: app.getVersion(),
        capabilities: { preflight: true, youtube: true, torrent: true },
        current: current?.state,
        queue: entries.map(({ id, filename, url, error, downloadId }) => ({
          id,
          filename: filename || new URL(url).pathname.split('/').pop() || 'download',
          error,
          downloadId
        }))
      }
    }
    if (message.action === 'show') {
      show()
      return { ok: true }
    }
    if (message.action === 'remove') {
      const found = entries.find((entry) => entry.id === message.id)
      if (found?.downloadId)
        throw new Error('Cancel or remove the current download in FluxFetch first')
      entries = entries.filter((entry) => entry.id !== message.id)
      await save()
      return { ok: true }
    }
    if (message.action !== 'download') throw new Error('Unknown browser command')
    const url = httpUrl(message.url)
    if (/\.(m3u8|mpd)(?:$|\?)/i.test(url.href))
      throw new Error('Streaming playlists are not supported')
    if (entries.length >= 100)
      throw new Error('Queue is full. Remove or finish queued downloads first.')
    const id =
      typeof message.id === 'string' && /^[\w-]{1,100}$/.test(message.id)
        ? message.id
        : randomUUID()
    if (entries.some((entry) => entry.id === id)) return { ok: true, id }
    const context = {
      origin: url.origin,
      headers: browserHeaders(url, {
        origin: url.origin,
        headers:
          typeof message.headers === 'object' && message.headers
            ? (message.headers as Record<string, string>)
            : {}
      })
    }
    const entry: Entry = {
      id,
      url: url.href,
      context,
      sourcePageUrl:
        typeof message.pageUrl === 'string' && /^https?:\/\//i.test(message.pageUrl)
          ? new URL(message.pageUrl).href
          : undefined,
      filename: typeof message.filename === 'string' ? message.filename.slice(0, 240) : ''
    }
    // Don't tell Chrome to cancel its working transfer until this client has fetched a
    // usable response. Challenge pages and 403s must stay in the browser's own session.
    if (message.preflight === true) {
      entry.probe = await checkFile(
        entry.url,
        entry.context,
        (await loadSettings()).customUserAgent
      )
      entry.probedAt = Date.now()
    }
    const displayName = entry.filename || entry.probe?.suggestedFileName || 'download'
    const size = entry.probe?.totalBytes
    const confirmation = await confirmDownload(
      displayName,
      `From ${url.origin}${size ? ` · ${formatFileSize(size)}` : ''}`
    )
    if (!confirmation.accepted) return { ok: true, cancelled: true }
    if (!isConnected()) return { ok: true, cancelled: true }
    entry.destinationDir = confirmation.destinationDir
    entry.temporaryDir = confirmation.temporaryDir
    entries.push(entry)
    try {
      await save()
    } catch (error) {
      entries.pop()
      throw error
    }
    show()
    return { ok: true, id, queued: true }
  }
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.setTimeout(5 * 60_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 1024 * 1024) {
        socket.destroy()
        return
      }
      const end = buffer.indexOf(10)
      if (end < 0) return
      socket.pause()
      void serial(async () => {
        try {
          return await dispatch(
            JSON.parse(buffer.subarray(0, end).toString('utf8')),
            () => !socket.destroyed
          )
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Browser request failed'
          }
        }
      }).then((response) => socket.end(`${JSON.stringify(response)}\n`))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipe, resolve)
  })
  const timer = setInterval(() => {
    void serial(tick).catch((error) => console.error('Browser queue:', error))
  }, 1500)
  server.on('close', () => clearInterval(timer))
  return server
}
