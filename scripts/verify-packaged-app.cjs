const { createHash } = require('node:crypto')
const { join } = require('node:path')
const asar = require('@electron/asar')

// Fail packaging before an installer can distribute a truncated or misaligned archive.
function verifyArchive(archive) {
  let checked = 0
  function walk(directory, prefix = '') {
    for (const [name, entry] of Object.entries(directory.files)) {
      const path = prefix ? join(prefix, name) : name
      if (entry.files) walk(entry, path)
      else if (!entry.link) {
        const content = asar.extractFile(archive, path)
        if (
          content.length !== entry.size ||
          !entry.integrity ||
          createHash('sha256').update(content).digest('hex') !== entry.integrity.hash
        ) {
          throw new Error(`Packaged app integrity check failed: ${path}`)
        }
        checked++
      }
    }
  }
  walk(asar.getRawHeader(archive).header)
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  for (const path of [metadata.main, 'out/preload/index.js', 'out/renderer/index.html']) {
    if (!path || !asar.extractFile(archive, path.replaceAll('/', require('node:path').sep)).length)
      throw new Error(`Packaged app entry point is missing: ${path}`)
  }
  console.log(`Verified packaged app: ${checked} files and all startup entry points.`)
}

module.exports = async ({ appOutDir, electronPlatformName }) => {
  const resources =
    electronPlatformName === 'darwin'
      ? join(appOutDir, 'FluxFetch.app', 'Contents', 'Resources')
      : join(appOutDir, 'resources')
  verifyArchive(join(resources, 'app.asar'))
}
module.exports.verifyArchive = verifyArchive

if (require.main === module) verifyArchive(process.argv[2])
