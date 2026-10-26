// Real, unprivileged engine-process checks. No TUN routes or drivers are changed.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { SocksProxyAgent } = require('socks-proxy-agent')

const root = path.resolve(__dirname, '..')
const executable = process.env.NET_MERGE_EXE || path.join(root, 'resources/net-merge/net-merge.exe')
const output = path.join(root, 'artifacts/net-merge-process-test')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
let engine
let server
let log = ''

async function freePort() {
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

async function stopEngine() {
  if (!engine || !engine.pid || engine.exitCode !== null) return
  const exited = once(engine, 'exit')
  engine.kill()
  await exited
  engine = null
}

async function startEngine(adapter, state, port) {
  engine = spawn(
    executable,
    [
      'socks',
      '-include',
      adapter,
      '-listen',
      `127.0.0.1:${port}`,
      '-state-dir',
      state,
      '-stats',
      '0',
      '-rescan',
      '500ms'
    ],
    { windowsHide: true }
  )
  engine.stdout.on('data', (bytes) => {
    log += bytes
  })
  engine.stderr.on('data', (bytes) => {
    log += bytes
  })
  engine.on('error', (error) => {
    log += error.message
  })
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (engine.exitCode !== null) throw new Error(`Engine exited: ${log}`)
    const ready = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ready) return
    await delay(100)
  }
  throw new Error(`Engine was not ready: ${log}`)
}

async function quota(state, adapter, bytes) {
  const id = randomUUID()
  await fs.writeFile(
    path.join(state, 'ctl/quota.tmp'),
    JSON.stringify({ id, adapter, bytes, daily: false, reset: true })
  )
  await fs.rename(path.join(state, 'ctl/quota.tmp'), path.join(state, 'ctl/quota'))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const result = await fs
      .readFile(path.join(state, 'quota-result.json'), 'utf8')
      .then(JSON.parse, () => null)
    if (result?.id === id) {
      assert.equal(result.error, '')
      return
    }
    await delay(50)
  }
  throw new Error(`Budget command not acknowledged: ${log}`)
}

function download(url, proxy) {
  return new Promise((resolve) => {
    const chunks = []
    let finished = false
    const finish = (error) => {
      if (!finished) {
        finished = true
        resolve({ body: Buffer.concat(chunks), error: error?.message || '' })
      }
    }
    const request = http.get(
      url,
      { agent: new SocksProxyAgent(proxy), timeout: 10000 },
      (response) => {
        response.on('data', (bytes) => chunks.push(bytes))
        response.once('end', () => finish())
        response.once('error', finish)
        response.once('aborted', () => finish(new Error('response aborted')))
      }
    )
    request.once('timeout', () => request.destroy(new Error('request timed out')))
    request.once('error', finish)
  })
}

async function main() {
  const selected = Object.entries(os.networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses || [])
        .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
        .map((a) => ({ name, address: a.address }))
    )
    .at(0)
  assert(selected, 'A usable physical IPv4 interface is required for the real engine-process test')
  await fs.mkdir(output, { recursive: true })
  const state = await fs.mkdtemp(path.join(output, 'state-'))
  await fs.writeFile(
    path.join(state, 'limits.json'),
    JSON.stringify({ version: 1, limits: { [selected.name]: 8 } })
  )
  const payload = Buffer.alloc(2 * 1024 * 1024)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251
  server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': payload.length
    })
    response.end(payload)
  })
  server.listen(0, selected.address)
  await once(server, 'listening')
  const port = await freePort()
  const url = `http://${selected.address}:${server.address().port}/payload`
  const proxy = `socks5://127.0.0.1:${port}`
  await startEngine(selected.name, state, port)
  const start = Date.now()
  const full = await download(url, proxy)
  const elapsed = Date.now() - start
  assert.equal(full.error, '', `Full transfer failed: ${full.error}\n${log}`)
  assert.equal(digest(full.body), digest(payload), 'Transferred payload did not match its source')
  assert(elapsed >= 1200, `8 Mbit/s adapter speed limit was bypassed (${elapsed} ms)`)
  const budget = 100000
  await quota(state, selected.name, budget)
  const capped = await download(url, proxy)
  assert(capped.error, 'Budgeted HTTP response should terminate before its full content length')
  assert(
    capped.body.length > 0 && capped.body.length < budget,
    `Expected a partial payload, received ${capped.body.length} bytes`
  )
  await stopEngine()
  await startEngine(selected.name, state, port)
  const afterRestart = await download(url, proxy)
  assert(afterRestart.error && afterRestart.body.length === 0, 'Restart replenished a spent budget')
  await quota(state, selected.name, 0)
  const resumed = await download(url, proxy)
  assert.equal(resumed.error, '')
  assert.equal(
    digest(resumed.body),
    digest(payload),
    'Disabling the cap failed to restore a correct transfer'
  )
  const result = {
    adapter: selected.name,
    payloadBytes: payload.length,
    limitedTransferMs: elapsed,
    capBytes: budget,
    cappedPayloadBytes: capped.body.length,
    restartPayloadBytes: afterRestart.body.length,
    payloadSHA256: digest(payload),
    passed: true
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopEngine()
    server?.closeAllConnections()
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    await fs.mkdir(output, { recursive: true })
    await fs.writeFile(path.join(output, 'engine.log'), log)
  })
