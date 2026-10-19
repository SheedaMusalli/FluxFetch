import { cp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK, expect, test } from './fixtures'

// D. Quitting, crashing and restarting. kill() is SIGKILL: no before-quit, no final save —
// what's on disk is whatever the app had managed to persist, exactly as after a crash or a
// power cut.

const SIZE = 32 * BLOCK

test.describe('restart @smoke', () => {
  test('normal quit mid-download → relaunch paused → resume', async ({ fluxfetch, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(10 * BLOCK + 500)
    const id = await fluxfetch.start(origin.url(), origin.sha256, { connections: 2 })
    await reached

    await fluxfetch.quit()
    origin.release()
    await fluxfetch.launch()

    const restored = await fluxfetch.current()
    expect(restored?.id).toBe(id)
    expect(restored?.status).toBe('paused')
    expect(restored?.bytesDownloaded).toBeGreaterThan(0)

    await fluxfetch.api.resumeDownload(id)
    await fluxfetch.waitForStatus('completed')
  })
})

test.describe('crash (SIGKILL) and recover @smoke', () => {
  // Offsets chosen to leave different part-file and manifest states behind: so early no progress
  // has been saved yet, and mid-block. Chaos covers the moments in between.
  for (const offset of [100, 3 * BLOCK + 777]) {
    test(`killed with a response held at byte ${offset}`, async ({ fluxfetch, serve }) => {
      const origin = await serve({ size: SIZE, seed: offset })
      const reached = origin.hold(offset)
      const id = await fluxfetch.start(origin.url(), origin.sha256, { connections: 4 })
      await reached
      // Give progress events and the throttled manifest save a chance to (partly) happen.
      await fluxfetch.waitUntil((state) => state.bytesDownloaded > 0)

      await fluxfetch.kill()
      origin.release()
      await fluxfetch.launch()

      const restored = await fluxfetch.current()
      expect(restored?.id).toBe(id)
      expect(restored?.status).toBe('paused')

      await fluxfetch.api.resumeDownload(id)
      await fluxfetch.waitForStatus('completed')
    })
  }
})

test.describe('persisted state on disk @smoke', () => {
  async function pausedDownload(
    fluxfetch: import('./fixtures').FluxFetchApp,
    serve: (o: { size: number; seed?: number }) => Promise<import('./origin').Origin>,
    seed = 1
  ): Promise<{ id: string; origin: import('./origin').Origin }> {
    const origin = await serve({ size: SIZE, seed })
    const reached = origin.hold(8 * BLOCK)
    const id = await fluxfetch.start(origin.url(), origin.sha256)
    await reached
    await fluxfetch.api.pauseDownload(id)
    await fluxfetch.waitForStatus('paused')
    origin.release()
    return { id, origin }
  }

  test('a corrupt manifest does not stop the app from starting', async ({
    fluxfetch,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(fluxfetch, serve)
    await fluxfetch.quit()
    await writeFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'not json {')
    await fluxfetch.launch()
    expect(await fluxfetch.current()).toBeNull()

    // And a new download still works.
    const origin = await serve({ size: 4 * BLOCK, seed: 99 })
    await fluxfetch.start(origin.url(), origin.sha256)
    await fluxfetch.waitForStatus('completed')
  })

  test('two saved downloads: only the newest is restored, the other is removed', async ({
    fluxfetch,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(fluxfetch, serve)
    await fluxfetch.quit()

    // Clone the saved download under another id, dated an hour earlier.
    const root = join(dirs.userData, 'downloads')
    const olderId = '00000000-0000-4000-8000-000000000000'
    await cp(join(root, id), join(root, olderId), { recursive: true })
    const manifestPath = join(root, olderId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.state.id = olderId
    manifest.state.startedAt -= 3_600_000
    await writeFile(manifestPath, JSON.stringify(manifest))

    await fluxfetch.launch()
    expect((await fluxfetch.current())?.id).toBe(id)
    await expect.poll(() => existsSync(join(root, olderId))).toBe(false)

    await fluxfetch.api.resumeDownload(id)
    await fluxfetch.waitForStatus('completed')
  })

  test('staging file deleted while the app was closed → reports lost progress', async ({
    fluxfetch,
    serve
  }) => {
    await pausedDownload(fluxfetch, serve)
    const current = (await fluxfetch.current())!
    const manifest = JSON.parse(
      await readFile(
        join(fluxfetch.dirs.userData, 'downloads', current.id, 'manifest.json'),
        'utf-8'
      )
    )
    await fluxfetch.quit()
    await rm(manifest.partialPath)
    await fluxfetch.launch()
    expect((await fluxfetch.current())?.status).toBe('error')
    expect((await fluxfetch.current())?.error).toMatch(/partial download file is missing/)
  })

  test('a download saved by the previous version resumes where it was', async ({
    fluxfetch,
    serve,
    dirs
  }) => {
    const { id, origin } = await pausedDownload(fluxfetch, serve)
    const paused = (await fluxfetch.current())!
    await fluxfetch.quit()

    // What version 4 wrote: every block whole, inside the state.
    const manifestPath = join(dirs.userData, 'downloads', id, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    delete manifest.progress
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        version: 4,
        state: { ...manifest.state, blocks: paused.blocks }
      })
    )

    await fluxfetch.launch()
    expect((await fluxfetch.current())?.bytesDownloaded).toBe(paused.bytesDownloaded)
    const before = origin.chunkRequests().length
    await fluxfetch.api.resumeDownload(id)
    await fluxfetch.waitForStatus('completed')
    const refetched = origin
      .chunkRequests()
      .slice(before)
      .some((request) => request.range!.start < paused.bytesDownloaded / 2)
    expect(refetched, 'what was already there is not fetched again').toBe(false)
  })

  test('a staging file cut short while the app was closed is fetched again', async ({
    fluxfetch,
    serve
  }) => {
    // What a power cut can do: the manifest says a block is done, but its data never all
    // reached the disk.
    const { id } = await pausedDownload(fluxfetch, serve)
    const state = (await fluxfetch.current())!
    const done = state.blocks!.find((block) => block.status === 'completed')!
    await fluxfetch.quit()
    const staging = `${state.destinationPath}.fluxfetch`
    await truncate(staging, done.rangeStart + 1000)

    await fluxfetch.launch()
    await fluxfetch.api.resumeDownload(id)
    await fluxfetch.waitForStatus('completed')
  })
})
