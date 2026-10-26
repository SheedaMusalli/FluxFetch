// Exercise real downloads in the shipped app, using its actual network adapters.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { _electron, expect } = require('@playwright/test')

async function main() {
  const root = path.resolve(__dirname, '..')
  const profile = await fs.mkdtemp(path.join(root, 'artifacts/library-packaged-profile-'))
  const data = Buffer.alloc(8 * 1024 * 1024, 0x5a)
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const server = http.createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
    const start = range ? Number(range[1]) : 0
    const end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ETag: '"packaged-library-fixture"',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {})
    })
    if (request.method === 'HEAD') return response.end()
    let offset = start
    const timer = setInterval(() => {
      const next = Math.min(offset + 32768, end + 1)
      response.write(data.subarray(offset, next))
      offset = next
      if (offset > end) {
        clearInterval(timer)
        response.end()
      }
    }, 40)
    response.on('close', () => clearInterval(timer))
  })
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
  let app
  try {
    app = await _electron.launch({
      executablePath:
        process.env.FLUXFETCH_PACKAGED_EXE ||
        path.join(root, 'artifacts/net-merge-release/win-unpacked/fluxfetch.exe'),
      args: [`--user-data-dir=${profile}`],
      timeout: 30000
    })
    const page = await app.firstWindow({ timeout: 15000 })
    await page.waitForLoadState('domcontentloaded')
    const runtime = await app.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      userData: app.getPath('userData')
    }))
    assert.equal(runtime.isPackaged, true)
    assert.equal(path.resolve(runtime.userData).toLowerCase(), profile.toLowerCase())
    const interfaces = await page.evaluate(() => window.fluxfetch.listInterfaces())
    const adapter = interfaces.find((item) =>
      item.addresses.some(
        (address) => address.family === 4 && !address.address.startsWith('169.254.')
      )
    )
    assert(adapter, 'No real IPv4 adapter available for packaged download checks')
    const address = adapter.addresses.find((item) => item.family === 4).address
    const url = `http://${address}:${server.address().port}/fixture.bin`
    const ids = await page.evaluate(
      async ({ url, profile, interfaceId }) => {
        const probe = await window.fluxfetch.probeUrl(url)
        return Promise.all(
          ['Packaged one.bin', 'Packaged two.bin', 'Packaged three.bin'].map((suggestedFileName) =>
            window.fluxfetch.startDownload({
              url: probe.finalUrl,
              totalBytes: probe.totalBytes,
              supportsRanges: probe.supportsRanges,
              destinationDir: `${profile}/downloads`,
              temporaryDir: `${profile}/temporary`,
              suggestedFileName,
              interfaceIds: [interfaceId],
              etag: probe.etag,
              lastModified: probe.lastModified,
              suppressNotifications: true
            })
          )
        )
      },
      { url, profile, interfaceId: adapter.id }
    )
    assert.equal(new Set(ids).size, 3)
    for (const id of ids)
      await expect(
        page.locator(`[data-download-id="${id}"]`).getByRole('progressbar')
      ).toBeVisible()
    await expect(page.getByRole('region', { name: 'Live torrent progress' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Pause Packaged one.bin', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Resume Packaged one.bin', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: path.join(root, 'artifacts/library-packaged-live.png') })
    await page.getByRole('button', { name: 'Resume Packaged one.bin', exact: true }).click()
    const results = []
    for (const id of ids) {
      await expect
        .poll(
          async () =>
            page.evaluate(async (id) => (await window.fluxfetch.getDownload(id))?.state.status, id),
          { timeout: 45000 }
        )
        .toBe('completed')
      const state = await page.evaluate(
        async (id) => (await window.fluxfetch.getDownload(id)).state,
        id
      )
      const checksum = hash(await fs.readFile(state.destinationPath))
      assert.equal(checksum, hash(data))
      results.push({ id, fileName: state.fileName, bytes: state.bytesDownloaded, sha256: checksum })
    }
    const result = {
      ...runtime,
      adapter: adapter.displayName,
      simultaneousDownloads: results,
      passed: true
    }
    await fs.writeFile(
      path.join(root, 'artifacts/library-packaged-result.json'),
      JSON.stringify(result, null, 2)
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    if (app) await app.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
