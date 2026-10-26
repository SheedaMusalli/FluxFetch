import type {} from '../src/preload/globals'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { IpcContract } from '../src/shared/ipc-contract'
import { applyDownloadUpdate } from '../src/shared/downloadUpdate'
import type { DownloadState, DownloadStatus, DownloadUpdate } from '../src/shared/types'
import { Origin, sha256, type OriginOptions } from './origin'

export { expect }

const PROJECT_ROOT = resolve(__dirname, '..')

/** Small blocks so a ~1 MB test file still splits into many of them. */
export const BLOCK = 64 * 1024

/**
 * The second source-bound socket fixture: a usable LAN address or distinct loopback alias.
 * The server distinguishes the sources for attribution and simulated interface changes.
 * global-setup.ts verifies that the source is observed correctly. This does not establish
 * physical multi-WAN throughput. The legacy environment variable name is kept for CI.
 */
export const LAN_ADDRESS = process.env.FLUXFETCH_E2E_LAN || null

export const NETWORKS = LAN_ADDRESS
  ? { a: '127.0.0.1', b: LAN_ADDRESS }
  : ({ a: '127.0.0.1' } as Record<string, string>)

export function interfacesEnv(networks: Record<string, string>): string {
  return Object.entries(networks)
    .map(([id, address]) => `${id}=${address}`)
    .join(',')
}

type Api = {
  [K in keyof IpcContract]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']>
}

interface StartOptions {
  networks?: string[]
  /** Streams per network, fixed so a test can count requests; 'auto' lets the app decide. */
  connections?: number | 'auto'
  /** With connections 'auto': the streams per network picked on the start screen. */
  streamsPerNetwork?: number
  fileName?: string
  destinationDir?: string
}

interface Tracked {
  expectedSha: string
  /** Files already in the destination folder before this download started. */
  destBefore: string[]
  destinationDir: string
}

/**
 * Drives one FluxFetch instance through the same `window.fluxfetch` API the renderer uses — nothing
 * below this reaches into the main process's internals, so refactoring them can't break a test
 * that still describes correct behavior.
 */
export class FluxFetchApp {
  electronApp!: ElectronApplication
  page!: Page
  /** Every downloadUpdated state, one array per app launch (a relaunch starts a new one). */
  readonly sessions: DownloadState[][] = []
  /** The same, as the window was sent them: only the blocks that changed. */
  readonly updates: DownloadUpdate[][] = []
  readonly tracked = new Map<string, Tracked>()
  readonly output: string[] = []
  alive = false

  constructor(
    readonly dirs: { userData: string; dest: string },
    private extraEnv: Record<string, string> = {}
  ) {}

  async launch(extraEnv: Record<string, string> = {}): Promise<this> {
    Object.assign(this.extraEnv, extraEnv)
    let retries = 5
    while (true) {
      try {
        this.electronApp = await electron.launch({
          args: [
            process.env.FLUXFETCH_E2E_APP_PATH || PROJECT_ROOT,
            ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
          ],
          env: (() => {
            const cleanEnv = { ...(process.env as Record<string, string>) }
            delete cleanEnv.ELECTRON_RUN_AS_NODE
            return {
              ...cleanEnv,
              FLUXFETCH_USER_DATA: this.dirs.userData,
              FLUXFETCH_E2E_HIDE_WINDOW: '1',
              FLUXFETCH_E2E_BLOCK_BYTES: String(BLOCK),
              FLUXFETCH_E2E_RETRY_BASE_MS: '20',
              FLUXFETCH_E2E_STALL_MS: '1500',
              // A busy server gives up after its retries alone, as any other wrong answer does,
              // unless a test waits it out on purpose.
              FLUXFETCH_E2E_SERVER_BUSY_MS: '1',
              // Off unless a test asks for it: a hedge is an extra request, and most tests count them.
              FLUXFETCH_E2E_HEDGE_MS: '600000',
              // Fixed for the same reason, and for downloads started through the UI.
              FLUXFETCH_E2E_STREAMS: '2',
              FLUXFETCH_E2E_INTERFACES: interfacesEnv(NETWORKS),
              ...this.extraEnv
            }
          })()
        })
        break
      } catch (e: unknown) {
        if (retries-- > 0 && e instanceof Error && e.message?.includes('ETXTBSY')) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        throw e
      }
    }
    const child = this.electronApp.process()
    child.stdout?.on('data', (data) => this.output.push(String(data)))
    child.stderr?.on('data', (data) => this.output.push(String(data)))
    this.alive = true

    this.page = await this.electronApp.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    const session: DownloadState[] = []
    const updates: DownloadUpdate[] = []
    this.sessions.push(session)
    this.updates.push(updates)
    // Kept whole, the way the window puts them together.
    const states = new Map<string, DownloadState>()
    await this.page.exposeFunction('__fluxfetchRecord', (update: DownloadUpdate) => {
      updates.push(update)
      const previous = states.get(update.state.id) ?? null
      const state = applyDownloadUpdate(previous, update)
      if (state && state !== previous) {
        states.set(state.id, state)
        session.push(state)
      }
    })
    await this.page.evaluate(() => {
      const w = window as unknown as { __fluxfetchRecord: (s: unknown) => void }
      window.fluxfetch.onDownloadUpdated((update) => w.__fluxfetchRecord(update))
    })
    return this
  }

  /** Kills the main process outright — no before-quit, no suspend: a crash or power cut. */
  async kill(): Promise<void> {
    const child = this.electronApp.process()
    const exited = new Promise((resolve) => child.once('exit', resolve))
    if (process.platform === 'win32') {
      // Playwright launches through a Windows shell. Killing only that shell
      // leaves Electron running, so the alleged crashed download can complete.
      const mainPid = await this.evaluateMain(() => process.pid, null)
      await promisify(execFile)('taskkill.exe', ['/PID', String(mainPid), '/T', '/F'], {
        windowsHide: true
      })
    } else child.kill('SIGKILL')
    await exited
    this.alive = false
  }

  /** Normal quit — runs before-quit, which suspends (pauses and persists) the download. */
  async quit(): Promise<void> {
    await this.electronApp.close()
    this.alive = false
  }

  async relaunch(extraEnv: Record<string, string> = {}): Promise<this> {
    if (this.alive) await this.quit()
    return this.launch(extraEnv)
  }

  api: Api = new Proxy({} as Api, {
    get:
      (_target, name: string) =>
      (...args: unknown[]) =>
        this.page.evaluate(
          ([method, params]) =>
            (window.fluxfetch as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
              ...params
            ),
          [name, args] as const
        )
  })

  /** Main-process code, e.g. to replace a dialog or make a network disappear. */
  evaluateMain<R, A>(fn: (electron: typeof import('electron'), arg: A) => R, arg: A): Promise<R> {
    return this.electronApp.evaluate(fn as never, arg) as Promise<R>
  }

  /** Sets how many streams the next download runs per network (see StartOptions). */
  private async pinStreams(connections: number | 'auto' = 2): Promise<void> {
    await this.evaluateMain(
      (_electron, value) => {
        if (value === null) delete process.env.FLUXFETCH_E2E_STREAMS
        else process.env.FLUXFETCH_E2E_STREAMS = value
      },
      connections === 'auto' ? null : String(connections)
    )
  }

  /** Probes and starts `url` exactly the way IdleScreen's Start button does. */
  async start(url: string, expectedSha: string, options: StartOptions = {}): Promise<string> {
    await this.pinStreams(options.connections)
    await this.api.listInterfaces()
    const probe = await this.api.probeUrl(url)
    const multiChunk = probe.supportsRanges && probe.totalBytes !== null
    const networks = options.networks ?? ['a']
    const destinationDir = options.destinationDir ?? this.dirs.dest
    const destBefore = existsSync(destinationDir) ? await readdir(destinationDir) : []

    const id = await this.api.startDownload({
      url: probe.finalUrl,
      destinationDir,
      suggestedFileName: options.fileName ?? probe.suggestedFileName,
      totalBytes: probe.totalBytes ?? 0,
      supportsRanges: multiChunk,
      interfaceIds: multiChunk ? networks : networks.slice(0, 1),
      etag: probe.etag,
      lastModified: probe.lastModified,
      streamsPerNetwork: options.streamsPerNetwork
    })
    this.tracked.set(id, { expectedSha, destBefore, destinationDir })
    return id
  }

  /** For downloads started through the UI rather than start(): declares what the next one
   * should produce, so the automatic checks can verify it. Call before clicking Start. */
  async expectNextDownload(expectedSha: string): Promise<void> {
    this.nextDownload = {
      expectedSha,
      destBefore: await readdir(this.dirs.dest),
      destinationDir: this.dirs.dest
    }
  }

  nextDownload: Tracked | null = null

  async current(): Promise<DownloadState | null> {
    const snapshot = await this.api.getCurrentDownload()
    return snapshot && applyDownloadUpdate(null, snapshot)
  }

  async waitForStatus(
    status: DownloadStatus | DownloadStatus[],
    timeout = 20_000
  ): Promise<DownloadState> {
    const wanted = Array.isArray(status) ? status : [status]
    return this.waitUntil((state) => wanted.includes(state.status), timeout)
  }

  /** Waits until the download state matches `predicate`. A timeout says what the state was
   * instead, so a hang shows the last progress and state. */
  async waitUntil(
    predicate: (state: DownloadState) => boolean,
    timeout = 20_000
  ): Promise<DownloadState> {
    const deadline = Date.now() + timeout
    let state: DownloadState | null = null
    while (Date.now() < deadline) {
      state = await this.current()
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const networks = state?.networks.map(
      (network) => `${network.id}:${network.status}${network.error ? ` (${network.error})` : ''}`
    )
    const chunks = state?.chunks.map((chunk) => `${chunk.interfaceId}:${chunk.status}`)
    throw new Error(
      `Timed out after ${timeout} ms waiting on the download. Last seen: ${
        state
          ? `status=${state.status}${state.error ? `, error="${state.error}"` : ''}, bytes=${state.bytesDownloaded}/${state.totalBytes}, networks=[${networks?.join(', ')}], chunks=[${chunks?.join(', ')}]`
          : 'no current download'
      }`
    )
  }
}

// --- invariants --------------------------------------------------------------------------------

const ALLOWED_NEXT: Record<DownloadStatus, DownloadStatus[]> = {
  downloading: ['downloading', 'paused', 'completed', 'error', 'cancelled'],
  paused: ['paused', 'downloading', 'error', 'cancelled'],
  completed: ['completed'],
  // Resumed.
  error: ['error', 'downloading'],
  cancelled: ['cancelled']
}

/** Rules every download event must satisfy, whatever the scenario. */
export function checkEvents(sessions: DownloadState[][]): void {
  for (const events of sessions) {
    const lastStatus = new Map<string, DownloadStatus>()
    for (const state of events) {
      const label = `${state.id} @ ${state.status}`
      if (state.totalBytes > 0) {
        expect(state.bytesDownloaded, `${label}: bytesDownloaded ≤ totalBytes`).toBeLessThanOrEqual(
          state.totalBytes
        )
      }
      expect(
        state.blocks?.every((block, index) => block?.index === index),
        `${label}: every block is there, in order`
      ).toBe(true)
      expect(state.blocks?.length, `${label}: as many blocks as planned`).toBe(state.totalBlocks)
      for (const block of state.blocks ?? []) {
        const attributed = Object.values(block.bytesByInterface).reduce((a, b) => a + b, 0)
        expect(attributed, `${label}: block ${block.index} attribution sums to its bytes`).toBe(
          block.bytesDownloaded
        )
        if (block.rangeEnd !== null) {
          const size = block.rangeEnd - block.rangeStart + 1
          expect(
            block.bytesDownloaded,
            `${label}: block ${block.index} within its size`
          ).toBeLessThanOrEqual(size)
          if (block.status === 'completed') {
            expect(block.bytesDownloaded, `${label}: completed block ${block.index} is full`).toBe(
              size
            )
          }
        }
      }
      if (state.status === 'downloading') {
        // A stream holds a block exactly while it is fetching it. A block has at most one stream
        // fetching it for real and two racing it as hedges, and is in flight whenever the first
        // is there. What the stream rows show is only as true as this.
        const primaries = new Map<number, number>()
        const hedges = new Map<number, number>()
        for (const chunk of state.chunks) {
          const holding = chunk.currentBlockIndex !== undefined
          expect(holding, `${label}: stream ${chunk.id} (${chunk.status}) holds a block`).toBe(
            chunk.status === 'downloading'
          )
          if (chunk.currentBlockIndex === undefined) {
            expect(chunk.hedge, `${label}: idle stream ${chunk.id} is not racing`).toBeFalsy()
            continue
          }
          const tally = chunk.hedge ? hedges : primaries
          tally.set(chunk.currentBlockIndex, (tally.get(chunk.currentBlockIndex) ?? 0) + 1)
        }
        for (const [index, count] of primaries) {
          expect(count, `${label}: block ${index} has one stream fetching it`).toBe(1)
        }
        for (const [index, count] of hedges) {
          expect(count, `${label}: block ${index} has at most two hedges`).toBeLessThanOrEqual(2)
        }
        for (const index of primaries.keys()) {
          expect(state.blocks?.[index]?.status, `${label}: held block ${index} is in flight`).toBe(
            'downloading'
          )
        }
      }
      const previous = lastStatus.get(state.id)
      if (previous) {
        expect(ALLOWED_NEXT[previous], `${state.id}: ${previous} → ${state.status}`).toContain(
          state.status
        )
      }
      lastStatus.set(state.id, state.status)
    }
  }
}

async function openFilesUnder(pid: number, roots: string[]): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-Fn', '-p', String(pid)])
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1))
      .filter((path) => roots.some((root) => path.startsWith(root)))
  } catch {
    return [] // lsof missing — skip this check rather than fail on it
  }
}

/**
 * The end-of-test rules: once a download has finished (either way), what's on disk must be
 * exactly right. The one that matters most: `completed` never means wrong bytes.
 */
export async function checkFinalState(app: FluxFetchApp): Promise<void> {
  const state = await app.current()
  if (!state) return
  const tracked = app.tracked.get(state.id) ?? app.nextDownload
  const terminal = ['completed', 'error', 'cancelled'].includes(state.status)
  if (!tracked || !terminal) return
  // A failed download keeps its progress to be resumed until the user moves on, as the window's
  // New Download does: after that, nothing may be left.
  if (state.status === 'error') await app.api.removeDownload(state.id)

  if (state.status === 'completed') {
    const bytes = await readFile(state.destinationPath)
    expect(sha256(bytes), 'completed file matches the source byte for byte').toBe(
      tracked.expectedSha
    )
  } else {
    expect(existsSync(state.destinationPath), 'no file left at the destination').toBe(false)
  }

  const destAfter = existsSync(tracked.destinationDir) ? await readdir(tracked.destinationDir) : []
  const added = destAfter.filter((name) => !tracked.destBefore.includes(name))
  const expectedAdded =
    state.status === 'completed' ? [state.destinationPath.split(/[\\/]/).pop()] : []
  expect(added, 'no stray files (placeholders, partials) in the destination folder').toEqual(
    expectedAdded
  )

  const stagingPath = `${state.destinationPath}.fluxfetch`
  await expect
    .poll(() => existsSync(stagingPath), { message: 'staging file cleaned up', timeout: 5000 })
    .toBe(false)

  const pid = app.electronApp.process().pid
  if (pid) {
    await expect
      .poll(() => openFilesUnder(pid, [app.dirs.dest, join(app.dirs.userData, 'downloads')]), {
        message: 'no file handles left open on download files',
        timeout: 5000
      })
      .toEqual([])
  }
}

// --- fixtures ----------------------------------------------------------------------------------

/** A fresh userData + destination folder pair under the OS temp directory. */
export async function makeDirs(): Promise<{
  dirs: { userData: string; dest: string }
  dispose: () => Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fluxfetch-e2e-')))
  const dirs = { userData: join(root, 'userData'), dest: join(root, 'dest') }
  await Promise.all([mkdir(dirs.userData), mkdir(dirs.dest)])
  return { dirs, dispose: () => rm(root, { recursive: true, force: true, maxRetries: 5 }) }
}

interface Fixtures {
  /** Extra environment for the app, e.g. `test.use({ appEnv: { FLUXFETCH_E2E_RETRY_BASE_MS: '2000' } })`. */
  appEnv: Record<string, string>
  dirs: { userData: string; dest: string }
  /** Starts a test server; every one started is stopped after the test. */
  serve: (options: OriginOptions) => Promise<Origin>
  fluxfetch: FluxFetchApp
  checks: void
}

export const test = base.extend<Fixtures>({
  appEnv: [{}, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  dirs: async ({}, use) => {
    const { dirs, dispose } = await makeDirs()
    await use(dirs)
    await dispose()
  },

  // eslint-disable-next-line no-empty-pattern
  serve: async ({}, use, testInfo) => {
    const origins: Origin[] = []
    await use(async (options) => {
      const origin = await new Origin(options).start()
      origins.push(origin)
      return origin
    })
    if (testInfo.status !== testInfo.expectedStatus) {
      const log = origins.map((origin) => origin.log)
      await testInfo.attach('server-requests.json', { body: JSON.stringify(log, null, 2) })
    }
    await Promise.all(origins.map((origin) => origin.stop()))
  },

  fluxfetch: async ({ dirs, appEnv }, use, testInfo) => {
    const app = new FluxFetchApp(dirs, { ...appEnv })
    await app.launch()
    await use(app)
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('download-events.json', {
        body: JSON.stringify(app.sessions, null, 2)
      })
      await testInfo.attach('app-output.txt', { body: app.output.join('') })
    }
    if (app.alive) await app.electronApp.close().catch(() => {})
  },

  checks: [
    async ({ fluxfetch }, use, testInfo) => {
      await use()
      // A test already failing (or expected to fail) has said what it needed to.
      if (testInfo.status !== 'passed' || testInfo.expectedStatus !== 'passed') return
      checkEvents(fluxfetch.sessions)
      // Listeners piling up on one stream or emitter: harmless today, a leak tomorrow.
      expect(fluxfetch.output.join(''), 'the app warned of a listener leak').not.toContain(
        'MaxListenersExceededWarning'
      )
      if (fluxfetch.alive) await checkFinalState(fluxfetch)
    },
    { auto: true }
  ]
})
