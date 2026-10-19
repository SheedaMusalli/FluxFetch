const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const AdmZip = require('adm-zip')
const root = path.resolve(__dirname, '..')

;(async () => {
  const lock = JSON.parse(await fs.readFile(path.join(root, 'torrent-engine.lock.json'), 'utf8'))
  const cache = path.join(root, 'artifacts/torrent-engine-cache')
  const output = path.join(root, 'resources/torrent-engine')
  const runtime = path.join(output, 'runtime')
  await fs.mkdir(cache, { recursive: true })
  await fs.mkdir(runtime, { recursive: true })
  for (const asset of lock.assets) {
    const cached = path.join(cache, asset.file)
    let bytes = await fs.readFile(cached).catch(() => null)
    const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
    if (!bytes || digest(bytes) !== asset.sha256) {
      const response = await fetch(asset.url)
      if (!response.ok) throw new Error(`Could not fetch ${asset.name}: ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      if (digest(bytes) !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.name}`)
      await fs.writeFile(cached, bytes)
    }
    new AdmZip(bytes).extractAllTo(runtime, true)
  }
  await fs.copyFile(
    path.join(root, 'integrations/torrent-engine/engine.py'),
    path.join(output, 'engine.py')
  )
  await fs.writeFile(path.join(runtime, 'python313._pth'), 'python313.zip\n.\n')
  await fs.writeFile(path.join(output, 'versions.json'), JSON.stringify(lock, null, 2))
  console.log('Prepared pinned Python 3.13.16 + native libtorrent 2.1.1 engine.')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
