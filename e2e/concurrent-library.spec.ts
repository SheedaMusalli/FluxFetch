import { readFile } from 'node:fs/promises'
import { BLOCK, expect, test } from './fixtures'
import { sha256 } from './origin'

test('three direct downloads have independent live rows, controls and files @smoke', async ({
  fluxfetch,
  serve
}, testInfo) => {
  const origins = await Promise.all(
    [1, 2, 3].map((seed) => serve({ size: 32 * BLOCK, seed, sharedBytesPerSecond: 256 * 1024 }))
  )
  const ids = await Promise.all(
    origins.map((origin, index) =>
      fluxfetch.start(origin.url(), origin.sha256, {
        fileName: index < 2 ? 'Shared.bin' : 'Third.bin'
      })
    )
  )
  expect(new Set(ids).size).toBe(3)
  const row = (id: string): import('@playwright/test').Locator =>
    fluxfetch.page.locator(`[data-download-id="${id}"]`)
  for (const id of ids) {
    await expect(row(id).getByRole('progressbar')).toBeVisible()
    await expect
      .poll(async () => (await fluxfetch.api.getDownload(id))?.state.bytesDownloaded ?? 0)
      .toBeGreaterThan(0)
  }
  await expect(fluxfetch.page.getByRole('region', { name: 'Live torrent progress' })).toHaveCount(0)
  const snapshots = await Promise.all(ids.map((id) => fluxfetch.api.getDownload(id)))
  expect(new Set(snapshots.map((item) => item!.state.destinationPath)).size).toBe(3)
  await row(ids[0])
    .getByRole('button', { name: /^Pause / })
    .click()
  await expect
    .poll(async () => (await fluxfetch.api.getDownload(ids[0]))?.state.status)
    .toBe('paused')
  const before = (await fluxfetch.api.getDownload(ids[1]))!.state.bytesDownloaded
  await expect
    .poll(async () => (await fluxfetch.api.getDownload(ids[1]))!.state.bytesDownloaded)
    .toBeGreaterThan(before)
  expect((await fluxfetch.api.getDownload(ids[0]))?.state.status).toBe('paused')
  await fluxfetch.page.reload()
  for (const id of ids) await expect(row(id)).toHaveCount(1)
  await expect(row(ids[0]).getByRole('button', { name: /^Resume / })).toBeVisible()
  await fluxfetch.page.screenshot({ path: testInfo.outputPath('three-live-downloads.png') })
  await row(ids[0])
    .getByRole('button', { name: /^Resume / })
    .click()
  for (let index = 0; index < ids.length; index++) {
    await expect
      .poll(async () => (await fluxfetch.api.getDownload(ids[index]))?.state.status, {
        timeout: 25000
      })
      .toBe('completed')
    const snapshot = (await fluxfetch.api.getDownload(ids[index]))!
    expect(sha256(await readFile(snapshot.state.destinationPath))).toBe(origins[index].sha256)
    await expect(row(ids[index]).getByRole('progressbar')).toHaveCount(0)
  }
  fluxfetch.tracked.clear()
})

test('multiple torrents and direct downloads appear together, with a torrent-only footer @smoke', async ({
  fluxfetch,
  serve
}) => {
  test.skip(process.platform !== 'win32', 'Bundled torrent engine is Windows-only')
  const origin = await serve({ size: 32 * BLOCK, sharedBytesPerSecond: 128 * 1024 })
  const direct = await fluxfetch.start(origin.url(), origin.sha256, {
    fileName: 'Concurrent direct.bin'
  })
  await fluxfetch.api.updateSettings({ destinationDir: fluxfetch.dirs.dest })
  for (const [hash, name] of [
    ['d'.repeat(40), 'Concurrent torrent one'],
    ['e'.repeat(40), 'Concurrent torrent two']
  ]) {
    const adding = fluxfetch.api.addTorrent(
      `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
    )
    const confirmation = fluxfetch.page
      .getByRole('dialog')
      .filter({ has: fluxfetch.page.getByRole('heading', { name: 'Add this torrent?' }) })
    await confirmation.getByRole('button', { name: 'Add torrent' }).click()
    expect(await adding).toBe(true)
    const torrentDialog = fluxfetch.page
      .getByRole('dialog')
      .filter({ has: fluxfetch.page.getByRole('heading', { name: 'FluxFetch torrents' }) })
    await torrentDialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await expect.poll(async () => (await fluxfetch.api.listTorrents()).length).toBe(2)
  const torrents = await fluxfetch.api.listTorrents()
  const table = fluxfetch.page.getByRole('table')
  for (const torrent of torrents) {
    await expect(
      table.locator(`[data-download-id="torrent:${torrent.gid}"]`).getByRole('progressbar')
    ).toBeVisible()
  }
  await expect(
    table.locator(`[data-download-id="${direct}"]`).getByRole('progressbar')
  ).toBeVisible()
  const footer = fluxfetch.page.getByRole('region', { name: 'Live torrent progress' })
  await expect(footer.getByRole('button')).toHaveCount(2)
  await expect(footer.getByText('Concurrent direct.bin')).toHaveCount(0)
  const first = table.locator(`[data-download-id="torrent:${torrents[0].gid}"]`)
  await first.getByRole('button', { name: /^Pause / }).click()
  await expect(first.getByRole('button', { name: /^Resume / })).toBeVisible()
  expect(
    (await fluxfetch.api.listTorrents()).find((item) => item.gid === torrents[1].gid)?.status
  ).not.toBe('paused')
  expect((await fluxfetch.api.getDownload(direct))?.state.status).toBe('downloading')
  await fluxfetch.page.reload()
  await expect(footer.getByRole('button')).toHaveCount(2)
  for (const torrent of torrents) await fluxfetch.api.removeTorrent(torrent.gid, false)
  await expect(footer).toHaveCount(0)
  await fluxfetch.api.cancelDownload(direct)
})
