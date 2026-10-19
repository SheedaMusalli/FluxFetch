// Exercise real background modules against each browser's supported listener options.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

async function verify(firefox) {
  let onMessage
  const id = firefox ? 'fluxfetch@fluxfetch.app' : 'hhepjnimojcdbcifmjaflopikglidjbo'
  const base = firefox ? 'moz-extension://fixture/' : `chrome-extension://${id}/`
  const event = () => ({
    addListener() {
      return undefined
    }
  })
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} }
  const runtime = {
    id,
    getURL: (name) => base + name,
    onInstalled: event(),
    onMessage: {
      addListener(listener) {
        onMessage = listener
      }
    },
    sendNativeMessage: async (host, message) => {
      assert.equal(host, 'com.fluxfetch.browser')
      assert.equal(message.action, 'status')
      return { ok: true, version: '2.0.0', capabilities: { preflight: true, torrent: true } }
    }
  }
  const chrome = {
    runtime,
    storage: { local: storage, session: storage },
    webRequest: {
      onBeforeSendHeaders: {
        addListener(_listener, _filter, options) {
          // Firefox throws synchronously here: this used to prevent onMessage registration.
          if (firefox && options.includes('extraHeaders'))
            throw Error('Invalid enumeration value extraHeaders')
          assert.ok(options.includes('requestHeaders'))
          if (!firefox) assert.ok(options.includes('extraHeaders'))
        }
      },
      onHeadersReceived: event()
    },
    contextMenus: { onClicked: event() },
    downloads: { onCreated: event() },
    alarms: { onAlarm: event() },
    tabs: { onRemoved: event() }
  }
  const context = vm.createContext({
    chrome,
    browser: firefox
      ? { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } }
      : undefined,
    console,
    URL
  })
  const cache = new Map()
  function load(file) {
    file = path.resolve(file)
    if (cache.has(file)) return cache.get(file)
    const exports = {}
    cache.set(file, exports)
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const execute = vm.runInContext(`(function(exports, require) {${output}\n})`, context, {
      filename: file
    })
    execute(exports, (name) => load(path.resolve(path.dirname(file), name)))
    return exports
  }
  load(path.join(__dirname, '..', 'extension/background.js'))
  assert.equal(typeof onMessage, 'function', 'Background must register its popup receiver')
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Popup status timed out')), 1000)
    const keepsChannelOpen = onMessage(
      { action: 'status' },
      { id, url: base + 'popup.html' },
      (result) => {
        clearTimeout(timer)
        resolve(result)
      }
    )
    assert.equal(keepsChannelOpen, true)
  })
  assert.equal(response.ok, true)
  assert.equal(
    onMessage({ action: 'status' }, { id: 'foreign-extension', url: base + 'popup.html' }, () =>
      assert.fail('Unauthorized sender accepted')
    ),
    undefined
  )
  console.log(
    `PASS: ${firefox ? 'Firefox' : 'Chromium'} background initializes, answers popup status and rejects foreign senders`
  )
}

verify(false)
  .then(() => verify(true))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
