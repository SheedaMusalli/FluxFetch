import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './fixtures'

test.skip(process.platform !== 'win32', 'The bundled libtorrent engine is currently Windows-only')

test('Windows magnet protocol links open FluxFetch and ask before adding the torrent', async ({
  fluxfetch
}) => {
  const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Protocol%20Test`
  await fluxfetch.evaluateMain(({ app }, link) => {
    app.emit('second-instance', {}, ['fluxfetch.exe', link])
  }, magnet)

  const confirmation = fluxfetch.page.getByRole('dialog')
  await expect(confirmation.getByRole('heading', { name: 'Add this torrent?' })).toBeVisible()
  await expect(confirmation.getByText('Protocol Test')).toBeVisible()
  await expect(confirmation.getByText('BitTorrent · magnet link')).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toBeHidden()
  expect(await fluxfetch.api.listTorrents()).toHaveLength(0)
})

test('built-in torrent engine accepts a .torrent file and exposes its state in FluxFetch', async ({
  fluxfetch,
  dirs
}) => {
  const path = join(dirs.userData, 'empty-test.torrent')
  // Known nonempty metadata; the fixture has no public tracker or swarm.
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from('d4:infod6:lengthi4e4:name4:test12:piece lengthi16384e6:pieces20:', 'ascii'),
      createHash('sha1').update('test').digest(),
      Buffer.from('ee')
    ])
  )
  await fluxfetch.api.updateSettings({ destinationDir: dirs.dest })
  await fluxfetch.evaluateMain(({ dialog }, torrentPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [torrentPath] })) as never
  }, path)

  const adding = fluxfetch.api.chooseTorrentFile()
  const confirmation = fluxfetch.page.getByRole('dialog')
  await expect(confirmation.getByRole('heading', { name: 'Add this torrent?' })).toBeVisible()
  await expect(confirmation.getByText('Save files to')).toBeVisible()
  await expect(confirmation.getByText('Temporary download data')).toHaveCount(0)
  await confirmation.getByRole('button', { name: 'Add torrent' }).click()
  expect(await adding).toBe(true)

  await expect
    .poll(async () => (await fluxfetch.api.listTorrents()).map((torrent) => torrent.name))
    .toContain('test')
  const [torrent] = await fluxfetch.api.listTorrents()
  expect(torrent.gid).toMatch(/^[a-f\d]+$/i)
  expect(['active', 'complete', 'stalled', 'checking', 'seeding']).toContain(torrent.status)
  expect(torrent.engine).toContain('libtorrent')
  expect(torrent.files?.[0].path).toBe('test')
  expect(torrent.contentPath).toBe(join(dirs.dest, 'test'))
  expect(torrent.sequentialDownload).toBe(false)
  await fluxfetch.evaluateMain(({ shell }) => {
    shell.openPath = (async (folder) => {
      process.env.FLUXFETCH_TEST_OPENED_TORRENT_FOLDER = folder
      return ''
    }) as typeof shell.openPath
  }, undefined)
  await fluxfetch.page.getByRole('button', { name: 'Torrent details' }).click()
  await expect(fluxfetch.page.getByText(/libtorrent 2/)).toBeVisible()
  await expect(fluxfetch.page.getByText(join(dirs.dest, 'test'), { exact: true })).toBeVisible()
  await fluxfetch.page.getByRole('button', { name: 'Open download folder' }).click()
  expect(
    await fluxfetch.evaluateMain(() => process.env.FLUXFETCH_TEST_OPENED_TORRENT_FOLDER, undefined)
  ).toBe(dirs.dest)
  await fluxfetch.page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(fluxfetch.page.getByText('0 B / 4 B')).toBeVisible()
  await fluxfetch.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  const footer = fluxfetch.page.getByRole('region', { name: 'Live download progress' })
  await expect(footer.getByRole('button', { name: /Torrent: test,/ })).toBeVisible()
  await expect(footer.getByRole('progressbar', { name: 'test progress' })).toHaveAttribute(
    'aria-valuenow',
    '0'
  )
  await fluxfetch.api.pauseTorrent(torrent.gid)
  await expect(footer.getByText('Paused', { exact: true })).toBeVisible()
  expect(
    (await fluxfetch.api.getTransferSummary()).items.find((item) => item.id === torrent.gid)
      ?.downloadSpeed
  ).toBe(0)
  await fluxfetch.api.removeTorrent(torrent.gid, true)
  await expect
    .poll(async () => (await fluxfetch.api.listTorrents()).some((item) => item.gid === torrent.gid))
    .toBe(false)
  await expect(footer).toHaveCount(0)
})

test('Windows .torrent file arguments open the destination confirmation', async ({
  fluxfetch,
  dirs
}) => {
  const path = join(dirs.userData, 'Open With test.torrent')
  await writeFile(path, Buffer.from('metadata is not read until the user accepts'))
  await fluxfetch.evaluateMain(({ app }, torrentPath) => {
    app.emit('second-instance', {}, ['fluxfetch.exe', torrentPath])
  }, path)
  const confirmation = fluxfetch.page.getByRole('dialog')
  await expect(confirmation.getByRole('heading', { name: 'Add this torrent?' })).toBeVisible()
  await expect(confirmation.getByText('Open With test.torrent')).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  expect(await fluxfetch.api.listTorrents()).toHaveLength(0)
})

test('an active magnet can be deleted before metadata or peers arrive', async ({
  fluxfetch,
  dirs
}) => {
  await fluxfetch.api.updateSettings({ destinationDir: dirs.dest })
  const adding = fluxfetch.api.addTorrent(
    'magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=metadata-delete-test'
  )
  const confirmation = fluxfetch.page.getByRole('dialog')
  await expect(confirmation.getByRole('heading', { name: 'Add this torrent?' })).toBeVisible()
  await confirmation.getByRole('button', { name: 'Add torrent' }).click()
  expect(await adding).toBe(true)
  await expect.poll(async () => fluxfetch.api.listTorrents()).toHaveLength(1)
  const [torrent] = await fluxfetch.api.listTorrents()

  await expect(fluxfetch.page.getByRole('heading', { name: 'FluxFetch torrents' })).toBeVisible()
  await fluxfetch.page.getByRole('button', { name: 'Delete torrent and downloaded files' }).click()
  const deleteDialog = fluxfetch.page.getByRole('heading', { name: 'Delete torrent and files?' })
  await expect(deleteDialog).toBeVisible()
  const deleteDialogContainer = fluxfetch.page.getByRole('dialog').filter({ has: deleteDialog })
  await expect(deleteDialogContainer.getByText(torrent.name, { exact: true })).toBeVisible()
  await fluxfetch.page.getByRole('button', { name: 'Delete files' }).click()
  await expect
    .poll(async () => (await fluxfetch.api.listTorrents()).some((item) => item.gid === torrent.gid))
    .toBe(false)
  await expect(deleteDialog).toBeHidden()
})
