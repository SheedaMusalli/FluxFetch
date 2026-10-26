import { BLOCK, expect, test } from './fixtures'

test('library status cards count and filter paused, cancelled and failed downloads', async ({
  fluxfetch
}) => {
  await fluxfetch.page.evaluate(() => {
    const entries = ['completed', 'downloading', 'paused', 'cancelled', 'error'].map(
      (status, index) => ({
        id: `card-${index}`,
        fileName: `${status}.bin`,
        status,
        url: 'https://fixture.test/file',
        destinationPath: `C:\\fixture\\${status}.bin`,
        totalBytes: 100,
        bytesDownloaded: 50,
        startedAt: 1,
        peakSpeedBytesPerSec: 0,
        avgSpeedBytesPerSec: 0
      })
    )
    localStorage.setItem('fluxfetch-download-history-v1', JSON.stringify(entries))
    window.dispatchEvent(new Event('fluxfetch-history-changed'))
  })
  for (const name of ['Completed', 'In progress', 'Paused', 'Cancelled', 'Failed']) {
    await expect(
      fluxfetch.page.getByRole('button', { name: `${name}: 1`, exact: true })
    ).toBeVisible()
  }
  for (const [label, file] of [
    ['Paused', 'paused.bin'],
    ['Cancelled', 'cancelled.bin'],
    ['Failed', 'error.bin']
  ]) {
    await fluxfetch.page.getByRole('button', { name: `${label}: 1`, exact: true }).click()
    await expect(fluxfetch.page.getByRole('table').getByRole('row')).toHaveCount(2)
    await expect(fluxfetch.page.getByRole('table').getByText(file)).toBeVisible()
  }
})

test('regular download progress is live in its library row without a footer', async ({
  fluxfetch,
  serve
}) => {
  const origin = await serve({ size: 32 * BLOCK, sharedBytesPerSecond: 128 * 1024 })
  const id = await fluxfetch.start(origin.url(), origin.sha256, { fileName: 'Footer transfer.bin' })
  const footer = fluxfetch.page.getByRole('region', { name: 'Live torrent progress' })
  const row = fluxfetch.page.locator(`[data-download-id="${id}"]`)
  await expect(row.getByRole('progressbar', { name: 'Footer transfer.bin progress' })).toBeVisible()
  await expect(footer).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (await fluxfetch.api.getTransferSummary()).items.find((item) => item.id === id)
          ?.downloadedBytes ?? 0
    )
    .toBeGreaterThan(0)
  await expect
    .poll(async () => (await fluxfetch.api.getTransferSummary()).downloadSpeed)
    .toBeGreaterThan(0)
  await fluxfetch.api.pauseDownload(id)
  await expect(row.getByRole('button', { name: 'Resume Footer transfer.bin' })).toBeVisible()
  expect((await fluxfetch.api.getTransferSummary()).downloadSpeed).toBe(0)
  await fluxfetch.api.cancelDownload(id)
  await expect(row.getByRole('progressbar')).toHaveCount(0)
  await expect(footer).toHaveCount(0)
})
