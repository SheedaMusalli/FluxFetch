// Offline regression coverage for first-run provisioning and overlapping video requests.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const vm = require('node:vm')
const ts = require('typescript')
const AdmZip = require('adm-zip')
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

;(async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'fluxfetch-media-regression-'))
  try {
    const files = {
      'yt-dlp.exe': Buffer.from('fixture resolver - never executed'),
      'deno.exe': Buffer.from('fixture runtime - never executed'),
      'ffmpeg.exe': Buffer.from('fixture merger - never executed'),
      'LICENSE.txt': Buffer.from('fixture ffmpeg license'),
      'yt-dlp-LICENSE.txt': Buffer.from('fixture resolver license'),
      'deno-LICENSE.txt': Buffer.from('fixture runtime license')
    }
    const zip = new AdmZip()
    zip.addFile('ffmpeg/bin/ffmpeg.exe', files['ffmpeg.exe'])
    zip.addFile('ffmpeg/LICENSE.txt', files['LICENSE.txt'])
    const archive = zip.toBuffer()
    const payloads = {
      'https://fixture.test/yt-dlp.exe': files['yt-dlp.exe'],
      'https://fixture.test/deno.exe': files['deno.exe'],
      'https://fixture.test/ffmpeg.zip': archive,
      'https://raw.githubusercontent.com/yt-dlp/yt-dlp/fixture/LICENSE':
        files['yt-dlp-LICENSE.txt'],
      'https://raw.githubusercontent.com/denoland/deno/fixture/LICENSE.md':
        files['deno-LICENSE.txt']
    }
    const records = [
      { repo: 'yt-dlp/yt-dlp', url: 'https://fixture.test/yt-dlp.exe' },
      { repo: 'denoland/deno', url: 'https://fixture.test/deno.exe' },
      { repo: 'yt-dlp/FFmpeg-Builds', url: 'https://fixture.test/ffmpeg.zip' }
    ].map((record) => ({
      ...record,
      version: 'fixture',
      sha256: `sha256:${hash(payloads[record.url])}`
    }))
    files['versions.json'] = Buffer.from(JSON.stringify(records, null, 2))
    await fs.writeFile(
      path.join(fixture, 'media-tools.lock.json'),
      JSON.stringify({
        records,
        files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]))
      })
    )
    let profile = path.join(fixture, 'profile')
    let rejectDownload = false
    const module = { exports: {} }
    const code = ts.transpileModule(
      await fs.readFile(path.join(__dirname, '../src/main/browser/mediaTools.ts'), 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        }
      }
    ).outputText
    vm.runInNewContext(code, {
      exports: module.exports,
      module,
      Buffer,
      AbortSignal,
      URL,
      require: (name) =>
        name === 'electron'
          ? {
              app: {
                isPackaged: true,
                getPath: () => profile,
                getAppPath: () => fixture
              }
            }
          : require(name),
      fetch: async (url) => {
        if (rejectDownload) throw new Error('fixture offline')
        assert.ok(payloads[url], `Unexpected network access: ${url}`)
        return { ok: true, arrayBuffer: async () => payloads[url] }
      }
    })
    const { ensureMediaTools } = module.exports
    const paths = await Promise.all([
      ensureMediaTools(),
      ensureMediaTools(true),
      ensureMediaTools()
    ])
    assert.equal(new Set(paths).size, 1)
    for (const [name, bytes] of Object.entries(files)) {
      assert.deepEqual(await fs.readFile(path.join(paths[0], name)), bytes)
    }
    profile = path.join(fixture, 'retry-profile')
    rejectDownload = true
    await assert.rejects(ensureMediaTools(), /fixture offline/)
    assert.deepEqual(await fs.readdir(profile), [])
    rejectDownload = false
    const retried = await ensureMediaTools()
    assert.deepEqual(await fs.readFile(path.join(retried, 'versions.json')), files['versions.json'])
    console.log(
      'PASS: first-run metadata creation, concurrent setup, cleanup and retry (offline fixtures).'
    )
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
