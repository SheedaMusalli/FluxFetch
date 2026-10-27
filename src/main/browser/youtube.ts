import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { DownloadManager } from '../download/downloadManager'
import { listActiveInterfaces } from '../network/interfaces'
import { probeUrl } from '../download/probe'
import { loadSettings } from '../settings'
import type { DownloadConfirmationResponse, StartDownloadRequest } from '../../shared/types'
import { getDefaultTemporaryDir, getSuggestedDownloadDir } from '../download/paths'
import { ensureMediaTools } from './mediaTools'

export function youtubeUrl(value: unknown): string {
  const url = new URL(String(value))
  if (
    url.protocol !== 'https:' ||
    !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Choose a video on YouTube first.')
  const id =
    url.pathname === '/watch'
      ? url.searchParams.get('v')
      : /^\/(?:shorts|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('Open a YouTube video first.')
  return `https://www.youtube.com/watch?v=${id}`
}

interface Choice {
  id: string
  label: string
  height?: number
  audioOnly?: boolean
}
interface YoutubeFormat {
  format_id?: string
  url?: string
  ext?: string
  height?: number
  vcodec?: string
  acodec?: string
  format_note?: string
  language?: string
  language_preference?: number
  filesize?: number
  filesize_approx?: number
  has_drm?: boolean
  http_headers?: Record<string, string>
}
interface VideoInfo {
  title?: string
  id?: string
  is_live?: boolean
  language?: string
  formats?: YoutubeFormat[]
}
interface YouTubeCookie {
  domain: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
}
interface Job {
  id: string
  url: string
  state: 'loading' | 'ready' | 'downloading' | 'complete' | 'error' | 'cancelled'
  title: string
  message: string
  choices: Choice[]
  formats: YoutubeFormat[]
  originalLanguage?: string
  inspectedAt?: number
  inspectPromise?: Promise<void>
  path?: string
  child?: ChildProcess
  activeDownloadId?: string
  startedAt?: number
  lastProgressAt?: number
}

const FORMAT_URL_MAX_AGE_MS = 5 * 60_000

function validCookies(value: unknown): YouTubeCookie[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error('The browser cookie list is invalid.')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('The browser cookie list is invalid.')
    const cookie = item as YouTubeCookie
    if (
      typeof cookie.domain !== 'string' ||
      !(cookie.domain === 'youtube.com' || cookie.domain.endsWith('.youtube.com')) ||
      typeof cookie.name !== 'string' ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/.test(cookie.name) ||
      typeof cookie.value !== 'string' ||
      cookie.value.length > 8192 ||
      [...cookie.value].some((character) => {
        const code = character.charCodeAt(0)
        return code <= 0x20 || code === 0x7f || character === ';' || character === ','
      }) ||
      typeof cookie.path !== 'string' ||
      !cookie.path.startsWith('/') ||
      /[\t\r\n]/.test(cookie.path)
    )
      throw new Error('The browser cookie list is invalid.')
    return cookie
  })
}

function cookieJar(cookies: YouTubeCookie[]): string {
  const rows = cookies
    .filter((cookie) => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000)
    .map((cookie) => {
      const domain = cookie.httpOnly ? `#HttpOnly_${cookie.domain}` : cookie.domain
      const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE'
      const expires = cookie.expirationDate ? Math.floor(cookie.expirationDate) : 0
      return [
        domain,
        includeSubdomains,
        cookie.path,
        cookie.secure ? 'TRUE' : 'FALSE',
        expires,
        cookie.name,
        cookie.value
      ].join('\t')
    })
  return `# Netscape HTTP Cookie File\n${rows.join('\n')}\n`
}

/** Only canonical YouTube URLs and internally generated format selectors reach the CLI. */
function stop(child?: ChildProcess): void {
  if (!child || child.exitCode !== null || !child.pid) return
  try {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000
    })
  } catch {
    child.kill()
  }
}

export class YoutubeDownloads {
  private jobs = new Map<string, Job>()
  private infoCache = new Map<string, { info: VideoInfo; timestamp: number }>()

  constructor(
    private readonly manager: DownloadManager,
    private readonly show: () => void,
    private readonly confirmDownload: (
      fileName: string,
      details: string
    ) => Promise<DownloadConfirmationResponse>
  ) {
    void this.removeAbandonedCookieFiles().catch(() => {})
    app.once('before-quit', () => {
      for (const job of this.jobs.values()) stop(job.child)
    })
  }

  isBusy(): boolean {
    return [...this.jobs.values()].some((job) => job.state === 'downloading')
  }

  private async removeAbandonedCookieFiles(): Promise<void> {
    const temp = app.getPath('temp')
    for (const name of await readdir(temp)) {
      if (!name.startsWith('fluxfetch-youtube-cookie-')) continue
      await rm(join(temp, name), { recursive: true, force: true })
    }
  }

  private view(job: Job): unknown {
    const { id, url, state, title, message, path } = job
    let visibleMessage = message
    if (state === 'downloading' && job.startedAt) {
      const idle = Math.floor((Date.now() - (job.lastProgressAt || job.startedAt)) / 1000)
      const elapsed = Math.floor((Date.now() - job.startedAt) / 1000)
      if (idle >= 90) {
        visibleMessage = `No new video data for ${idle}s. You can wait, or cancel and choose a lower quality.`
      } else if (idle >= 15 && /^Starting download/.test(message)) {
        visibleMessage = `Connecting to YouTube… (${elapsed}s). Large or high-quality videos may take longer to start.`
      }
    }
    return {
      ok: true,
      job: {
        id,
        url,
        state,
        title,
        message: visibleMessage,
        path,
        choices: job.choices.map(({ id, label, height, audioOnly }) => ({
          id,
          label,
          height:
            typeof height === 'number'
              ? height
              : /^h(\d+)$/.exec(id)
                ? parseInt(id.slice(1), 10)
                : undefined,
          audioOnly: Boolean(audioOnly || id === 'audio')
        }))
      }
    }
  }

  private async run(
    job: Job,
    args: string[],
    timeout: number,
    line: (line: string) => void,
    cookies: YouTubeCookie[] = []
  ): Promise<void> {
    let cookieDirectory: string | undefined
    let cookieFile: string | undefined
    try {
      const tools = await ensureMediaTools()
      if (cookies.length) {
        cookieDirectory = await mkdtemp(
          join(app.getPath('temp'), `fluxfetch-youtube-cookie-${randomUUID()}-`)
        )
        cookieFile = join(cookieDirectory, 'cookies.txt')
        const contents = cookieJar(cookies)
        await writeFile(cookieFile, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        args = ['--cookies', cookieFile, ...args]
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          join(tools, 'yt-dlp.exe'),
          [
            '--ignore-config',
            '--no-playlist',
            '--no-colors',
            '--newline',
            '--no-cache-dir',
            '--no-js-runtimes',
            '--js-runtimes',
            `deno:${join(tools, 'deno.exe')}`,
            '--ffmpeg-location',
            tools,
            '--socket-timeout',
            '20',
            '--retries',
            '2',
            ...args,
            '--',
            job.url
          ],
          { windowsHide: true, shell: false }
        )
        job.child = child
        let pending = '',
          errors = '',
          total = 0,
          overflow = false
        const timer = setTimeout(() => {
          overflow = true
          stop(child)
        }, timeout)
        child.stdout.on('data', (data: Buffer) => {
          total += data.length
          if (total > 32 * 1024 * 1024) {
            overflow = true
            stop(child)
            return
          }
          pending += data.toString()
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() || ''
          for (const value of lines) line(value)
        })
        child.stderr.on('data', (data: Buffer) => {
          let text = data.toString()
          for (const cookie of cookies) {
            if (cookie.value.length >= 6) text = text.replaceAll(cookie.value, '[redacted]')
          }
          errors = (errors + text).slice(-6000)
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          job.child = undefined
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          job.child = undefined
          if (pending) line(pending)
          if (job.state === 'cancelled') {
            reject(new Error('Cancelled'))
            return
          }
          if (code === 0 && !overflow) {
            resolve()
            return
          }
          const reason = errors.split(/\r?\n/).findLast((value) => value.startsWith('ERROR:'))
          reject(
            new Error(
              overflow
                ? 'YouTube took too long to respond. Try again.'
                : (
                    reason ||
                    'YouTube download failed. This video may require sign-in or be unavailable.'
                  )
                    .replace(/https?:\/\/\S+/g, '[link]')
                    .slice(0, 600)
            )
          )
        })
      })
    } finally {
      if (cookieFile && cookieDirectory) {
        try {
          const contents = cookieJar(cookies)
          await writeFile(cookieFile, Buffer.alloc(Buffer.byteLength(contents)))
          await rm(cookieDirectory, { recursive: true, force: true })
        } catch {
          await rm(cookieDirectory, { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  }

  async dispatch(message: Record<string, unknown>): Promise<unknown> {
    const url = youtubeUrl(message.url)
    if (message.action === 'youtubeInspect') {
      const existing = [...this.jobs.values()].findLast(
        (job) => job.url === url && !['error', 'cancelled', 'complete'].includes(job.state)
      )
      if (existing) return this.view(existing)
      if ([...this.jobs.values()].filter((job) => job.child).length >= 3)
        throw new Error('Please finish or cancel another YouTube request first.')
      if (this.jobs.size >= 30) {
        for (const [id, job] of this.jobs)
          if (!job.child) {
            this.jobs.delete(id)
            break
          }
      }
      const job: Job = {
        id: randomUUID(),
        url,
        state: 'loading',
        title: 'YouTube video',
        message: 'Finding available qualities…',
        choices: [],
        formats: []
      }
      this.jobs.set(job.id, job)
      job.inspectPromise = this.inspect(job)
      return this.view(job)
    }
    const job =
      this.jobs.get(String(message.id)) ||
      [...this.jobs.values()].findLast(
        (j) => j.url === url && !['error', 'cancelled'].includes(j.state)
      )
    if (!job || job.url !== url) throw new Error('Open the download menu again.')
    if (message.action === 'youtubeStatus') return this.view(job)
    if (message.action === 'youtubeCancel') {
      job.state = 'cancelled'
      job.message = 'Cancelled. Partial files may remain in the download folder.'
      stop(job.child)
      if (job.activeDownloadId) void this.manager.cancel(job.activeDownloadId)
      return this.view(job)
    }
    if (message.action !== 'youtubeDownload') throw new Error('Unknown YouTube command')
    const withCookies = message.cookies !== undefined
    if (job.state === 'loading' && job.inspectPromise) {
      await job.inspectPromise
    }
    if (
      withCookies &&
      (job.state !== 'error' || !/sign in|not a bot|cookies-from-browser/i.test(job.message))
    )
      throw new Error('Retry with sign-in is offered only when YouTube requests authentication.')
    if (job.state !== 'ready' && !withCookies)
      throw new Error('This video is already downloading or needs a fresh quality check.')
    const choice = job.choices.find((choice) => choice.id === message.choice)
    if (!choice) throw new Error('Choose an available quality.')
    if ([...this.jobs.values()].some((other) => other.state === 'downloading'))
      throw new Error('Finish or cancel the current YouTube download first.')
    const cookies = withCookies ? validCookies(message.cookies) : []
    const userAgent =
      withCookies &&
      typeof message.userAgent === 'string' &&
      message.userAgent.length <= 512 &&
      message.userAgent.startsWith('Mozilla/5.0 ')
        ? message.userAgent
        : undefined
    job.state = 'downloading'
    job.message = 'Starting download…'
    job.startedAt = Date.now()
    job.lastProgressAt = job.startedAt
    void this.download(job, choice, cookies, userAgent)
    return this.view(job)
  }

  private async inspect(job: Job): Promise<void> {
    try {
      const info = await this.extractInfo(job)
      if (info.is_live)
        throw new Error(
          'Live broadcasts are not supported. Try the archived video after the stream ends.'
        )
      job.title = String(info.title || 'YouTube video').slice(0, 200)
      job.originalLanguage = typeof info.language === 'string' ? info.language : undefined
      job.formats = (info.formats || []).filter(
        (format) => !format.has_drm && (!format.url || this.validMediaUrl(format.url))
      )
      job.inspectedAt = Date.now()
      const heights = [
        ...new Set(
          job.formats
            .filter(
              (format) =>
                format.vcodec && format.vcodec !== 'none' && Number.isFinite(format.height)
            )
            .map((format) => Math.floor(format.height!))
        )
      ]
        .sort((a, b) => b - a)
        .slice(0, 12)
      job.choices = heights.map((height) => ({
        id: `h${height}`,
        label: `${height}p · Video + audio`,
        height
      }))
      if (
        job.formats.some(
          (format) => format.vcodec === 'none' && format.acodec && format.acodec !== 'none'
        )
      )
        job.choices.push({ id: 'audio', label: 'Audio only · Original format', audioOnly: true })
      if (!job.choices.length)
        throw new Error('No downloadable formats are available for this video.')
      if (
        job.formats.some(
          (format) => format.vcodec && format.vcodec !== 'none' && format.acodec === 'none'
        ) &&
        job.formats.some(
          (format) => format.vcodec === 'none' && format.acodec && format.acodec !== 'none'
        )
      ) {
        // Fetch the optional merger while the user is choosing a quality instead of after both
        // large streams have already downloaded. A failure is retried by muxVideo when needed.
        void ensureMediaTools(true).catch((error) =>
          console.warn('[youtube] Could not prefetch the video merger:', error)
        )
      }
      job.state = 'ready'
      job.message = 'Choose a quality. Files save to your FluxFetch download folder.'
    } catch (error) {
      this.fail(job, error)
    }
  }

  private validMediaUrl(raw?: string): boolean {
    if (!raw || raw.length > 32768) return false
    try {
      const url = new URL(raw)
      return (
        url.protocol === 'https:' &&
        (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))
      )
    } catch {
      return false
    }
  }

  private async extractInfo(
    job: Job,
    cookies: YouTubeCookie[] = [],
    userAgent?: string
  ): Promise<VideoInfo> {
    if (!cookies.length && !userAgent) {
      const cached = this.infoCache.get(job.url)
      if (cached && Date.now() - cached.timestamp < 10 * 60_000) {
        return cached.info
      }
    }
    let info: VideoInfo | undefined
    const args = ['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist']
    if (userAgent) args.push('--user-agent', userAgent)
    await this.run(
      job,
      args,
      120000,
      (value) => {
        try {
          info = JSON.parse(value) as VideoInfo
        } catch {
          /* Ignore non-JSON output. */
        }
      },
      cookies
    )
    if (!info) throw new Error('YouTube did not return video formats. Try again.')
    if (!cookies.length && !userAgent) {
      this.infoCache.set(job.url, { info, timestamp: Date.now() })
    }
    return info
  }

  private async download(
    job: Job,
    choice: Choice,
    cookies: YouTubeCookie[],
    userAgent?: string
  ): Promise<void> {
    let temporaryFolder: string | undefined
    const reservedOutputs: string[] = []
    const childJobs: string[] = []
    try {
      if (this.isCancelled(job)) return
      // The quality list already came from yt-dlp. Reuse its short-lived signed URLs for a
      // quick start; only repeat extraction when they are old or an authenticated retry needs it.
      let formats = job.formats
      const cachedFormatsAreFresh =
        !cookies.length &&
        !!job.inspectedAt &&
        Date.now() - job.inspectedAt <= FORMAT_URL_MAX_AGE_MS &&
        formats.length > 0
      if (!cachedFormatsAreFresh) {
        job.message = 'Refreshing YouTube stream links…'
        const info = await this.extractInfo(job, cookies, userAgent)
        formats = (info.formats || []).filter(
          (format) => !format.has_drm && this.validMediaUrl(format.url)
        )
        job.formats = formats
        job.inspectedAt = Date.now()
        if (info.title) job.title = String(info.title).slice(0, 200)
        if (typeof info.language === 'string') job.originalLanguage = info.language
      }
      const selected = this.selectFormats(formats, choice, job.originalLanguage)
      if (!selected.video && !selected.audio)
        throw new Error('That YouTube quality is no longer available. Reopen the quality menu.')
      const finalExtension = selected.video
        ? this.videoExtension(selected.video, selected.audio)
        : selected.audio?.ext || 'm4a'
      const finalFileName = `${this.safeStem(job.title)}.${finalExtension}`
      job.message = 'Waiting for your confirmation…'
      const confirmation = await this.confirmDownload(finalFileName, `YouTube · ${choice.label}`)
      if (!confirmation.accepted) {
        job.state = 'cancelled'
        job.message = 'Download cancelled before any video data was transferred.'
        return
      }
      // Bring FluxFetch forward as soon as the user accepts. Network route checks and
      // destination preparation happen inside manager.start before its download window opens.
      this.show()
      const settings = await loadSettings()
      const destination =
        confirmation.destinationDir ||
        (settings.destinationDir
          ? getSuggestedDownloadDir(settings.destinationDir, finalFileName)
          : app.getPath('videos'))
      const temporaryDir = confirmation.temporaryDir || getDefaultTemporaryDir()
      await mkdir(destination, { recursive: true })
      await mkdir(temporaryDir, { recursive: true })
      temporaryFolder = await mkdtemp(join(temporaryDir, `.fluxfetch-youtube-${randomUUID()}-`))
      // Start optional FFmpeg provisioning before the streams finish, so a first-use merger
      // download cannot leave completed audio and video sitting in the staging folder.
      if (selected.video) void ensureMediaTools(true).catch(() => {})
      const names: string[] = []
      if (selected.video)
        names.push(
          await this.downloadStream(
            job,
            selected.video,
            temporaryFolder,
            'video',
            childJobs,
            finalFileName
          )
        )
      if (this.isCancelled(job)) return
      if (selected.audio)
        names.push(
          await this.downloadStream(
            job,
            selected.audio,
            temporaryFolder,
            'audio',
            childJobs,
            finalFileName
          )
        )
      if (job.state === 'cancelled') return
      if (selected.video && selected.audio) {
        job.message = 'Combining video and audio in FluxFetch…'
        const output = await this.uniquePath(destination, this.safeStem(job.title), finalExtension)
        reservedOutputs.push(output)
        const fallbackOutput =
          finalExtension === 'mp4'
            ? await this.uniquePath(destination, this.safeStem(job.title), 'mkv')
            : undefined
        if (fallbackOutput) reservedOutputs.push(fallbackOutput)
        const mergedPath = await this.muxVideo(names[0], names[1], output, fallbackOutput)
        await Promise.all(
          reservedOutputs
            .filter((path) => path !== mergedPath)
            .map((path) => rm(path, { force: true }).catch(() => {}))
        )
        job.path = mergedPath
        reservedOutputs.length = 0
      } else if (names[0]) {
        const source = names[0]
        const isVideo = Boolean(selected.video)
        const ext = isVideo ? finalExtension : selected.audio?.ext || 'm4a'
        const output = await this.uniquePath(destination, this.safeStem(job.title), ext)
        reservedOutputs.push(output)
        if (isVideo) {
          job.message = 'Preparing MP4 in FluxFetch…'
          const fallbackOutput =
            ext === 'mp4'
              ? await this.uniquePath(destination, this.safeStem(job.title), 'mkv')
              : undefined
          if (fallbackOutput) reservedOutputs.push(fallbackOutput)
          const mergedPath = await this.muxVideo(source, undefined, output, fallbackOutput)
          await Promise.all(
            reservedOutputs
              .filter((path) => path !== mergedPath)
              .map((path) => rm(path, { force: true }).catch(() => {}))
          )
          job.path = mergedPath
        } else {
          await rm(output, { force: true })
          await rename(source, output)
          job.path = output
        }
        reservedOutputs.length = 0
      }
      job.state = 'complete'
      job.message = `Saved with FluxFetch${job.path ? ': ' + job.path : ' to your FluxFetch download folder'}`
      if (job.path) {
        await this.manager.publishMergedFile(childJobs, job.path, job.url)
        this.manager.notifyExternalCompletion(job.path.split(/[\\/]/).pop() || job.path)
      }
    } catch (error) {
      await Promise.all(reservedOutputs.map((path) => rm(path, { force: true }).catch(() => {})))
      const reason = error instanceof Error ? error.message : String(error)
      if (cookies.length && /sign in|not a bot|cookies-from-browser/i.test(reason))
        this.fail(
          job,
          new Error(
            'YouTube rejected this browser session even with its cookies and browser identity. Sign in to YouTube in this browser, refresh the video page, and retry once. If it still fails, YouTube may have expired the cookies or blocked this network; repeated retries may put the account at risk.'
          )
        )
      else this.fail(job, error)
    } finally {
      for (const id of childJobs) await this.manager.remove(id).catch(() => {})
      job.activeDownloadId = undefined
      if (temporaryFolder)
        await rm(temporaryFolder, { recursive: true, force: true }).catch(() => {})
    }
  }

  private selectFormats(
    formats: YoutubeFormat[],
    choice: Choice,
    originalLanguage?: string
  ): { video?: YoutubeFormat; audio?: YoutubeFormat } {
    const audioFormats = formats
      .filter((format) => format.acodec && format.acodec !== 'none' && format.vcodec === 'none')
      .sort((a, b) => this.compareAudioPreference(a, b, originalLanguage))
    const audio = audioFormats[0]
    if (choice.audioOnly) return { audio }

    const videos = formats.filter(
      (format) =>
        format.vcodec &&
        format.vcodec !== 'none' &&
        (format.height || 0) <= (choice.height || 0)
    )
    const byVideoQuality = (a: YoutubeFormat, b: YoutubeFormat): number =>
      (b.height || 0) - (a.height || 0) ||
      (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0)
    const combined = videos
      .filter((format) => format.acodec && format.acodec !== 'none')
      .sort(
        (a, b) =>
          (b.height || 0) - (a.height || 0) ||
          this.compareAudioPreference(a, b, originalLanguage)
      )[0]
    const videoOnly = videos
      .filter((format) => !format.acodec || format.acodec === 'none')
      .sort(byVideoQuality)[0]

    if (combined) {
      const combinedHasPreferredTrack =
        audio &&
        this.hasOriginalAudioSignal(combined, originalLanguage) &&
        this.compareAudioPreference(combined, audio, originalLanguage) <= 0
      const onlyOneAudioTrack = audioFormats.length <= 1 && !this.isDubbedAudio(combined)
      if (!audio || !videoOnly || combinedHasPreferredTrack || onlyOneAudioTrack)
        return { video: combined }
    }

    return { video: videoOnly || combined, audio }
  }

  private compareAudioPreference(
    a: YoutubeFormat,
    b: YoutubeFormat,
    originalLanguage?: string
  ): number {
    const originalA = /\boriginal\b/i.test(a.format_note || '')
    const originalB = /\boriginal\b/i.test(b.format_note || '')
    if (originalA !== originalB) return Number(originalB) - Number(originalA)

    const languageA = this.languagesMatch(a.language, originalLanguage)
    const languageB = this.languagesMatch(b.language, originalLanguage)
    if (languageA !== languageB) return Number(languageB) - Number(languageA)

    const preferenceA =
      typeof a.language_preference === 'number' && Number.isFinite(a.language_preference)
        ? a.language_preference
        : Number.NEGATIVE_INFINITY
    const preferenceB =
      typeof b.language_preference === 'number' && Number.isFinite(b.language_preference)
        ? b.language_preference
        : Number.NEGATIVE_INFINITY
    if (preferenceA !== preferenceB) return preferenceB - preferenceA

    const dubbedA = this.isDubbedAudio(a)
    const dubbedB = this.isDubbedAudio(b)
    if (dubbedA !== dubbedB) return Number(dubbedA) - Number(dubbedB)

    return (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0)
  }

  private hasOriginalAudioSignal(format: YoutubeFormat, originalLanguage?: string): boolean {
    return (
      /\boriginal\b/i.test(format.format_note || '') ||
      this.languagesMatch(format.language, originalLanguage) ||
      (typeof format.language_preference === 'number' && format.language_preference >= 10)
    )
  }

  private isDubbedAudio(format: YoutubeFormat): boolean {
    return /\b(?:dub(?:bed)?|descriptive|audio description)\b/i.test(format.format_note || '')
  }

  private languagesMatch(trackLanguage?: string, originalLanguage?: string): boolean {
    const normalize = (language?: string): string =>
      typeof language === 'string' ? language.trim().toLowerCase().replace(/_/g, '-') : ''
    const track = normalize(trackLanguage)
    const original = normalize(originalLanguage)
    return Boolean(
      track &&
        original &&
        (track === original || track.startsWith(original + '-') || original.startsWith(track + '-'))
    )
  }
  private async downloadStream(
    job: Job,
    format: YoutubeFormat,
    folder: string,
    kind: string,
    ids: string[],
    displayFileName: string
  ): Promise<string> {
    if (!format.url || !this.validMediaUrl(format.url))
      throw new Error('YouTube returned an unsupported media stream URL.')
    const url = new URL(format.url)
    const streamContext = {
      origin: url.origin,
      headers: this.safeFormatHeaders(format.http_headers)
    }
    // Use yt-dlp's exact filesize from the just-inspected format when it is still fresh. This
    // avoids another network round trip before the real download window appears. Approximate
    // sizes are never trusted; unknown or stale sizes still use the normal one-byte probe.
    const exactSizeIsFresh =
      Number.isSafeInteger(format.filesize) &&
      format.filesize! >= 0 &&
      !!job.inspectedAt &&
      Date.now() - job.inspectedAt <= FORMAT_URL_MAX_AGE_MS
    const probe = exactSizeIsFresh ? undefined : await probeUrl(url.href, streamContext)
    const request: StartDownloadRequest = {
      url: url.href,
      destinationDir: folder,
      temporaryDir: folder,
      suggestedFileName: `${kind}.${(format.ext || 'bin').replace(/[^a-z0-9]/gi, '')}`,
      displayFileName,
      displayLocation: 'YouTube · preparing final file',
      totalBytes: exactSizeIsFresh ? format.filesize! : (probe?.totalBytes ?? 0),
      supportsRanges: probe?.supportsRanges ?? exactSizeIsFresh,
      interfaceIds: (await listActiveInterfaces()).map((network) => network.id),
      etag: probe?.etag ?? null,
      lastModified: probe?.lastModified ?? null,
      browserContext: streamContext,
      suppressNotifications: true
    }
    job.message = `FluxFetch is downloading ${kind}…`
    job.lastProgressAt = Date.now()
    if (this.isCancelled(job)) throw new Error('Cancelled')
    const id = await this.manager.start(request)
    job.activeDownloadId = id
    ids.push(id)
    while (true) {
      if (this.isCancelled(job)) {
        await this.manager.cancel(id)
        throw new Error('Cancelled')
      }
      const current = await this.manager.getDownload(id)
      if (!current) throw new Error(`The ${kind} download was removed.`)
      if (current.state.id === id) {
        const state = current.state
        job.message = `FluxFetch ${kind}: ${state.totalBytes > 0 ? Math.min(99, Math.floor((state.bytesDownloaded / state.totalBytes) * 100)) : '—'}% · ${(state.speedBytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
        job.lastProgressAt = Date.now()
        if (state.status === 'completed') return state.destinationPath
        if (state.status === 'error')
          throw new Error(state.error || `FluxFetch could not download the ${kind} stream.`)
        if (state.status === 'cancelled') throw new Error('Cancelled')
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  private safeFormatHeaders(source?: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(source || {})) {
      if (
        /^(user-agent|accept|accept-language)$/i.test(key) &&
        typeof value === 'string' &&
        !/[\r\n\0]/.test(value)
      )
        result[key.toLowerCase()] = value
    }
    return result
  }

  private isCancelled(job: Job): boolean {
    return job.state === 'cancelled'
  }

  private safeStem(value: string): string {
    const safe = [...value].map((character) => {
      const code = character.charCodeAt(0)
      return '<>:"/\\|?*'.includes(character) || code < 32 ? '_' : character
    })
    return (
      safe
        .join('')
        .replace(/[. ]+$/g, '')
        .slice(0, 150) || 'YouTube video'
    )
  }

  private async uniquePath(folder: string, stem: string, ext: string): Promise<string> {
    for (let i = 0; i < 10000; i++) {
      const suffix = i ? ` (${i})` : ''
      const path = join(folder, `${stem}${suffix}.${ext}`)
      try {
        const handle = await open(path, 'wx')
        await handle.close()
        return path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('Could not choose an unused output file name.')
  }

  private videoExtension(video: YoutubeFormat, audio?: YoutubeFormat): 'mp4' | 'mkv' {
    const videoCodec = (video.vcodec || '').toLowerCase()
    const audioCodec = (audio?.acodec || video.acodec || '').toLowerCase()
    const mp4Video = /^(avc1|avc3|h264|h\.264|hvc1|hev1|hevc|av01|mp4v|mpeg4)/.test(videoCodec)
    const mp4Audio =
      !audioCodec ||
      audioCodec === 'none' ||
      /^(mp4a|aac|ac-3|ac3|ec-3|eac3|alac|mp3)/.test(audioCodec)
    return mp4Video && mp4Audio ? 'mp4' : 'mkv'
  }

  private async muxVideo(
    video: string,
    audio: string | undefined,
    output: string,
    fallbackOutput?: string
  ): Promise<string> {
    const tools = await ensureMediaTools(true)
    const run = (target: string, transcodeAudio: boolean): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video]
        if (audio) args.push('-i', audio)
        args.push('-map', '0:v:0')
        if (audio) args.push('-map', '1:a:0')
        else args.push('-map', '0:a?')
        if (transcodeAudio) {
          // YouTube commonly pairs VP9/AV1 video with Opus audio. MP4 can keep the video
          // bit-for-bit and convert only audio to AAC when needed.
          args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k')
        } else args.push('-c', 'copy')
        if (/\.mp4$/i.test(target)) args.push('-movflags', '+faststart')
        args.push(target)
        const child = spawn(join(tools, 'ffmpeg.exe'), args, {
          windowsHide: true,
          shell: false
        })
        let errors = ''
        child.stderr.on('data', (chunk: Buffer) => {
          errors = (errors + chunk.toString()).slice(-2000)
        })
        child.once('error', reject)
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(errors.trim() || `FFmpeg exited with code ${code ?? 'unknown'}.`))
        )
      })

    let lastError: unknown
    try {
      await run(output, false)
      return output
    } catch (error) {
      lastError = error
      await rm(output, { force: true }).catch(() => {})
    }
    if (/\.mp4$/i.test(output)) {
      try {
        await run(output, true)
        return output
      } catch (error) {
        lastError = error
        await rm(output, { force: true }).catch(() => {})
      }
    }
    if (fallbackOutput) {
      try {
        // Matroska accepts YouTube's VP9/AV1 + Opus pairs without a slow, lossy transcode.
        await run(fallbackOutput, false)
        return fallbackOutput
      } catch (error) {
        lastError = error
        await rm(fallbackOutput, { force: true }).catch(() => {})
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError || '')
    throw new Error(`FluxFetch could not combine these YouTube streams. ${reason}`.slice(0, 1200))
  }

  private fail(job: Job, error: unknown): void {
    if (job.state === 'cancelled') return
    job.state = 'error'
    job.message = error instanceof Error ? error.message : 'YouTube request failed'
  }
}
