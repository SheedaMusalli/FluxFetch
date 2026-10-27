const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const AdmZip = require('adm-zip')
const root = path.resolve(__dirname, '..')
const keyDir = path.join(root, '.signing')
fs.mkdirSync(keyDir, { recursive: true })
const keyFile = path.join(keyDir, 'extension.pem')
if (!fs.existsSync(keyFile))
  fs.writeFileSync(
    keyFile,
    crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    }).privateKey
  )
const key = fs.readFileSync(keyFile)
const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })
const idBytes = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16)
const id = [...idBytes.toString('hex')]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('')
const manifestFile = path.join(root, 'extension', 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestFile))
manifest.key = publicKey.toString('base64')
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
fs.copyFileSync(
  path.join(root, 'build', 'extension-icon.png'),
  path.join(root, 'extension', 'icon.png')
)
fs.writeFileSync(path.join(root, 'native-host', 'extension-id.txt'), id)
fs.writeFileSync(
  path.join(root, 'native-host', 'com.fluxfetch.browser.json'),
  `${JSON.stringify(
    {
      name: 'com.fluxfetch.browser',
      description: 'FluxFetch browser integration',
      path: 'FluxFetch.BrowserHost.exe',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${id}/`]
    },
    null,
    2
  )}\n`
)
const firefoxId = 'fluxfetch@fluxfetch.app'
const firefoxManifestFile = path.join(root, 'native-host', 'com.fluxfetch.browser.firefox.json')
fs.writeFileSync(
  firefoxManifestFile,
  `${JSON.stringify(
    {
      name: 'com.fluxfetch.browser',
      description: 'FluxFetch browser integration for Firefox',
      path: 'FluxFetch.BrowserHost.exe',
      type: 'stdio',
      allowed_extensions: [firefoxId]
    },
    null,
    2
  )}\n`
)

// Keep a complete, load-unpacked Firefox clone beside the Chromium extension.
const firefoxDir = path.join(root, 'extension-firefox')
fs.mkdirSync(firefoxDir, { recursive: true })
fs.cpSync(path.join(root, 'extension'), firefoxDir, { recursive: true })
const firefoxManifestPath = path.join(firefoxDir, 'manifest.json')
const firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, 'utf8'))
delete firefoxManifest.key
delete firefoxManifest.minimum_chrome_version
firefoxManifest.version = '2.1'
firefoxManifest.background = { scripts: ['background.js'], type: 'module' }
firefoxManifest.browser_specific_settings = {
  gecko: {
    id: firefoxId,
    strict_min_version: '142.0',
    data_collection_permissions: { required: ['none'] }
  }
}
fs.writeFileSync(firefoxManifestPath, `${JSON.stringify(firefoxManifest, null, 2)}\n`)
fs.writeFileSync(
  path.join(firefoxDir, 'README.md'),
  '# FluxFetch for Firefox\n\nInstall FluxFetch for Firefox from [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/fluxfetch-integration-module/). The add-on needs the FluxFetch Windows app to handle downloads.\n\nFor local development, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and choose this folder’s `manifest.json`. Temporary add-ons must be loaded again after Firefox restarts. See the [browser setup guide](https://github.com/SheedaMusalli/FluxFetch/blob/main/docs/BROWSER-SETUP.md).\n'
)

// Edge rejects Chromium packages that carry Chrome's extension identity key.
const edgeDir = path.join(root, 'extension-edge')
fs.mkdirSync(edgeDir, { recursive: true })
fs.cpSync(path.join(root, 'extension'), edgeDir, { recursive: true })
const edgeManifestPath = path.join(edgeDir, 'manifest.json')
const edgeManifest = JSON.parse(fs.readFileSync(edgeManifestPath, 'utf8'))
delete edgeManifest.key
edgeManifest.version = '1.0.0'
fs.writeFileSync(edgeManifestPath, `${JSON.stringify(edgeManifest, null, 2)}\n`)
// Keep generated metadata in the same format enforced by `npm run format:check`.
execFileSync(
  process.execPath,
  [
    require.resolve('prettier/bin/prettier.cjs'),
    '--write',
    manifestFile,
    path.join(root, 'native-host', 'com.fluxfetch.browser.json'),
    firefoxManifestPath,
    edgeManifestPath,
    firefoxManifestFile
  ],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
)
const out = process.env.FLUXFETCH_RELEASE_DIR || path.join(root, 'release')
fs.mkdirSync(out, { recursive: true })
const firefoxZipFile = path.join(out, 'FluxFetch-Firefox.zip')
if (fs.existsSync(firefoxZipFile)) fs.unlinkSync(firefoxZipFile)
const firefoxArchive = new AdmZip()
firefoxArchive.addLocalFolder(firefoxDir)
firefoxArchive.writeZip(firefoxZipFile)
const firefoxXpiFile = path.join(out, 'FluxFetch-Firefox.xpi')
if (fs.existsSync(firefoxXpiFile)) fs.unlinkSync(firefoxXpiFile)
firefoxArchive.writeZip(firefoxXpiFile)
const edgeZipFile = path.join(out, 'FluxFetch-Edge.zip')
if (fs.existsSync(edgeZipFile)) fs.unlinkSync(edgeZipFile)
const edgeArchive = new AdmZip()
edgeArchive.addLocalFolder(edgeDir)
edgeArchive.writeZip(edgeZipFile)
const zipFile = path.join(out, 'FluxFetch-Chrome.zip')
if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile)
const archive = new AdmZip()
archive.addLocalFolder(path.join(root, 'extension'))
archive.writeZip(zipFile)
const zip = fs.readFileSync(path.join(out, 'FluxFetch-Chrome.zip'))
function varint(n) {
  const bytes = []
  while (n > 127) {
    bytes.push((n & 127) | 128)
    n >>>= 7
  }
  bytes.push(n)
  return Buffer.from(bytes)
}
function field(n, data) {
  return Buffer.concat([varint((n << 3) | 2), varint(data.length), data])
}
function uint32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const signedHeader = field(1, idBytes)
const signature = crypto.sign(
  'sha256',
  Buffer.concat([Buffer.from('CRX3 SignedData\0'), uint32(signedHeader.length), signedHeader, zip]),
  key
)
const header = Buffer.concat([
  field(2, Buffer.concat([field(1, publicKey), field(2, signature)])),
  field(10000, signedHeader)
])
fs.writeFileSync(
  path.join(out, 'FluxFetch-Chrome.crx'),
  Buffer.concat([Buffer.from('Cr24'), uint32(3), uint32(header.length), header, zip])
)
console.log('Extension ID:', id)
