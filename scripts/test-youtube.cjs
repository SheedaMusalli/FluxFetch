const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = ts.transpileModule(readFileSync('src/main/browser/youtube.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }
}).outputText
const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
function fixture() {
  const children = [],
    calls = [],
    downloadRequests = [],
    app = new EventEmitter(),
    exported = {}
  Object.assign(app, {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => 'test-downloads'
  })
  const manager = {
    async start(request) {
      downloadRequests.push(request)
      return 'download-' + downloadRequests.length
    },
    async getDownload(id) {
      const request = downloadRequests[Number(id.slice('download-'.length)) - 1]
      return { state: { id, status: 'completed', destinationPath: 'C:\\Downloads\\' + request.suggestedFileName, totalBytes: request.totalBytes, bytesDownloaded: request.totalBytes, speedBytesPerSec: 0 } }
    },
    async cancel() {},
    async remove() {},
    async publishMergedFile() {},
    notifyExternalCompletion() {}
  }
  const context = {
    exports: exported,
    process,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'electron') return { app }
      if (name === '../settings')
        return { loadSettings: async () => ({ destinationDir: 'test-downloads' }) }
      if (name === '../network/interfaces') return { listActiveInterfaces: async () => [] }
      if (name === '../download/probe') return { probeUrl: async () => ({}) }
      if (name === '../download/paths') return { getDefaultTemporaryDir: () => 'temp', getSuggestedDownloadDir: () => 'test-downloads' }
      if (name === './mediaTools') return { ensureMediaTools: async () => 'media-tools' }
      if (name === 'node:fs/promises') return { mkdir: async () => {}, mkdtemp: async () => 'temp', open: async () => ({ close: async () => {} }), rename: async () => {}, rm: async () => {}, readdir: async () => [], writeFile: async () => {} }
      if (name === 'node:child_process')
        return {
          execFileSync(_exe, args) {
            children.find((child) => String(child.pid) === args[1])?.kill()
          },
          spawn(exe, args, options) {
            calls.push({ exe, args, options })
            const child = new EventEmitter()
            Object.assign(child, {
              stdout: new EventEmitter(),
              stderr: new EventEmitter(),
              pid: 90000 + children.length,
              exitCode: null,
              kill() {
                child.exitCode = 1
                child.emit('close', 1)
              }
            })
            children.push(child)
            return child
          }
        }
      return require(name)
    }
  }
  vm.runInNewContext(source, context)
  return { engine: new exported.YoutubeDownloads(manager, () => {}, async () => ({ accepted: true, destinationDir: 'test-downloads', temporaryDir: 'temp' })), children, calls, downloadRequests, app }
}
const next = () => new Promise((resolve) => setImmediate(resolve))
async function ready(f) {
  const { job } = await f.engine.dispatch({ action: 'youtubeInspect', url })
  const child = f.children[0]
  child.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({
        title: 'Test',
        formats: [
          { height: 720, vcodec: 'avc1', acodec: 'none', url: 'https://r1.googlevideo.com/video' },
          { height: 2160, vcodec: 'avc1', acodec: 'none', has_drm: true },
          { vcodec: 'none', acodec: 'opus', url: 'https://r1.googlevideo.com/audio', language: 'en', language_preference: 10 }
        ]
      }) + '\n'
    )
  )
  child.exitCode = 0
  child.emit('close', 0)
  await next()
  return job.id
}
test('prefers original-language audio over a larger dubbed track and dubbed combined stream', () => {
  const f = fixture()
  const formats = [
    { format_id: 'video-only-720', height: 720, vcodec: 'avc1', acodec: 'none', filesize: 2000 },
    { format_id: 'combined-dub-720', height: 720, vcodec: 'avc1', acodec: 'mp4a', format_note: 'Dubbed', language: 'es', language_preference: -1, filesize: 20000 },
    { format_id: 'audio-dub', vcodec: 'none', acodec: 'opus', format_note: 'Dubbed', language: 'es', language_preference: -1, filesize: 9000 },
    { format_id: 'audio-original', vcodec: 'none', acodec: 'opus', format_note: 'Original', language: 'en', language_preference: 10, filesize: 1000 }
  ]
  const audio = f.engine.selectFormats(formats, { id: 'audio', audioOnly: true })
  assert.equal(audio.audio.format_id, 'audio-original')
  const video = f.engine.selectFormats(formats, { id: 'h720', height: 720 }, 'en-US')
  assert.equal(video.video.format_id, 'video-only-720')
  assert.equal(video.audio.format_id, 'audio-original')
})

test('matches the source language when yt-dlp omits original-track labels', () => {
  const f = fixture()
  const formats = [
    { format_id: 'large-dub', vcodec: 'none', acodec: 'opus', language: 'es', filesize: 9000 },
    { format_id: 'small-original', vcodec: 'none', acodec: 'opus', language: 'en', filesize: 1000 }
  ]
  const audio = f.engine.selectFormats(formats, { id: 'audio', audioOnly: true }, 'en-US')
  assert.equal(audio.audio.format_id, 'small-original')
})

test('rejects other origins and format injection; only enumerated formats reach a shell-free process', async () => {
  const f = fixture()
  await assert.rejects(
    f.engine.dispatch({
      action: 'youtubeInspect',
      url: 'https://youtube.com.evil.example/watch?v=jNQXAC9IVRw'
    })
  )
  const id = await ready(f)
  const response = await f.engine.dispatch({ action: 'youtubeStatus', id, url })
  assert.equal(response.job.choices.length, 2)
  await assert.rejects(
    f.engine.dispatch({ action: 'youtubeDownload', url, id, choice: '--exec calc.exe' })
  )
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].options.shell, false)
  assert.equal(f.calls[0].args.at(-1), url)
  await f.engine.dispatch({ action: 'youtubeDownload', url, id, choice: 'audio' })
  await next()
  assert.equal(f.downloadRequests.length, 1)
  assert.equal(f.downloadRequests[0].url, 'https://r1.googlevideo.com/audio')
})
test('cancellation before asynchronous folder preparation never starts a download', async () => {
  const f = fixture(),
    id = await ready(f)
  await f.engine.dispatch({ action: 'youtubeDownload', url, id, choice: 'h720' })
  await f.engine.dispatch({ action: 'youtubeCancel', url, id })
  await next()
  assert.equal(f.children.length, 1)
  const response = await f.engine.dispatch({ action: 'youtubeStatus', url, id })
  assert.equal(response.job.state, 'cancelled')
})
test('completes an audio download, deduplicates inspection, and cancels a later inspection on shutdown', async () => {
  const f = fixture(),
    id = await ready(f)
  assert.equal((await f.engine.dispatch({ action: 'youtubeInspect', url })).job.id, id)
  await f.engine.dispatch({ action: 'youtubeDownload', url, id, choice: 'audio' })
  await next()
  const status = await f.engine.dispatch({ action: 'youtubeStatus', url, id })
  assert.equal(status.job.state, 'complete')
  assert.equal(f.downloadRequests.length, 1)
  const nextUrl = 'https://www.youtube.com/watch?v=abcdefghijk'
  const nextJob = await f.engine.dispatch({ action: 'youtubeInspect', url: nextUrl })
  assert.notEqual(nextJob.job.id, id)
  for (let i = 0; i < 10 && f.children.length < 2; i++) await next()
  assert.equal(f.children.length, 2)
  f.app.emit('before-quit')
  assert.equal(f.children[1].exitCode, 1)
})
