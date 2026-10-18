import { randomBytes, scryptSync, timingSafeEqual, X509Certificate } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:https'
import { app, safeStorage } from 'electron'
import { generate } from 'selfsigned'
import type { DownloadManager } from './download/downloadManager'
import { loadSettings } from './settings'

type RemoteCredentials = { username: string; salt: string; hash: string }
type CertificatePair = { key: string; cert: string }
let server: Server | null = null
let managerRef: DownloadManager | null = null
const authFailures = new Map<string, { count: number; since: number }>()

const credentialsPath = (): string => join(app.getPath('userData'), 'remote-access.bin')
const certificatePath = (): string => join(app.getPath('userData'), 'remote-access-cert.json')

async function loadCredentials(): Promise<RemoteCredentials | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const encrypted = await readFile(credentialsPath())
    const raw = JSON.parse(safeStorage.decryptString(encrypted)) as Partial<RemoteCredentials>
    return typeof raw.username === 'string' &&
      typeof raw.salt === 'string' &&
      typeof raw.hash === 'string'
      ? (raw as RemoteCredentials)
      : null
  } catch {
    return null
  }
}

export async function saveRemoteCredentials(username: string, password: string): Promise<void> {
  const cleanUsername = username.trim()
  if (!/^[\w.-]{3,64}$/.test(cleanUsername))
    throw new Error('Username must be 3–64 letters, numbers, dots, dashes, or underscores.')
  if (password.length < 14 || password.length > 256)
    throw new Error('Use a remote access password with at least 14 characters.')
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'Windows credential encryption is unavailable; remote access cannot store its password securely.'
    )
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  const encrypted = safeStorage.encryptString(
    JSON.stringify({ username: cleanUsername, salt, hash })
  )
  await writeFile(credentialsPath(), encrypted, { mode: 0o600 })
}

async function certificate(): Promise<CertificatePair> {
  try {
    const parsed = JSON.parse(await readFile(certificatePath(), 'utf8')) as CertificatePair
    if (parsed.key && parsed.cert) return parsed
  } catch {
    // Create the persistent local TLS certificate on first use.
  }
  const generated = await generate([{ name: 'commonName', value: 'FluxFetch Remote' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...Object.values(networkInterfaces())
            .flatMap((items) => items ?? [])
            .filter((item) => !item.internal && item.family === 'IPv4')
            .map((item) => ({ type: 7 as const, ip: item.address }))
        ]
      }
    ]
  })
  const pair = { key: generated.private, cert: generated.cert }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(certificatePath(), JSON.stringify(pair), { mode: 0o600 })
  return pair
}

function authorized(header: string | undefined, saved: RemoteCredentials): boolean {
  if (!header?.startsWith('Basic ')) return false
  let decoded: string
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return false
  }
  const colon = decoded.indexOf(':')
  if (colon < 0 || decoded.slice(0, colon) !== saved.username) return false
  const supplied = scryptSync(decoded.slice(colon + 1), saved.salt, 64)
  const expected = Buffer.from(saved.hash, 'hex')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  })
  response.end(JSON.stringify(data))
}

async function readBody(
  request: import('node:http').IncomingMessage
): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) {
    body += chunk.toString()
    if (body.length > 16_384) throw new Error('Request body is too large.')
  }
  const parsed: unknown = body ? JSON.parse(body) : {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Invalid request body.')
  return parsed as Record<string, unknown>
}

const dashboard = `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>FluxFetch Remote</title><style>
body{font:15px system-ui;margin:0;background:#17191b;color:#eee}main{max-width:900px;margin:32px auto;padding:0 18px}h1{font-size:22px}form,.card{background:#202326;border:1px solid #34383b;border-radius:12px;padding:16px;margin:14px 0}input,button{font:inherit;color:inherit;background:#292d30;border:1px solid #444;border-radius:8px;padding:10px}input{box-sizing:border-box;width:100%;margin:5px 0 10px}button{cursor:pointer}button.primary{background:#d6a13d;color:#17191b;border:0}button.danger{color:#ff9b9b}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.meta{color:#9da5ac;font-size:13px}.title{font-weight:600;overflow-wrap:anywhere}.card .row{margin-top:10px}#downloads{margin-top:20px}</style><main><h1>FluxFetch Remote</h1><p class="meta">Manage downloads on your FluxFetch PC. The connection is encrypted; use your FluxFetch remote username and password.</p><form id="login"><label>Username<input id="user" autocomplete="username" required></label><label>Password<input id="pass" type="password" autocomplete="current-password" required></label><button class="primary">Connect</button></form><form id="add" hidden><label>Download URL<input id="url" type="url" placeholder="https://example.com/file.zip" required></label><button class="primary">Add download</button><button type="button" id="logout">Disconnect</button></form><p id="status" class="meta"></p><section id="downloads"></section><script>
let auth=sessionStorage.getItem('ff-auth')||'';const status=document.querySelector('#status');function headers(){return {'Authorization':'Basic '+auth,'X-FluxFetch-Remote':'1','Content-Type':'application/json'}}async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:headers(),body:body?JSON.stringify(body):undefined});if(r.status===401)throw Error('Sign in again.');const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data}function showConnected(on){document.querySelector('#login').hidden=on;document.querySelector('#add').hidden=!on}async function refresh(){try{const rows=await api('/api/downloads');document.querySelector('#downloads').innerHTML=rows.map(d=>'<article class="card"><div class="title">'+escapeHtml(d.fileName)+'</div><div class="meta">'+escapeHtml(d.status)+' · '+format(d.bytesDownloaded)+' of '+format(d.totalBytes)+' · '+(d.speedBytesPerSec/1048576).toFixed(1)+' MB/s</div><div class="row">'+(d.status==='downloading'?'<button data-action="pause" data-id="'+d.id+'">Pause</button>':'')+(d.status==='paused'||d.status==='error'?'<button data-action="resume" data-id="'+d.id+'">Resume</button>':'')+(d.status==='downloading'||d.status==='paused'?'<button class="danger" data-action="cancel" data-id="'+d.id+'">Cancel</button>':'')+'</div></article>').join('')||'<p class="meta">No downloads yet.</p>';status.textContent='Connected'}catch(e){status.textContent=e.message;showConnected(false)}}function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function format(n){if(!n)return '—';const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+' '+u[i]}document.querySelector('#login').onsubmit=async e=>{e.preventDefault();auth=btoa(unescape(encodeURIComponent(document.querySelector('#user').value+':'+document.querySelector('#pass').value)));try{await api('/api/downloads');sessionStorage.setItem('ff-auth',auth);showConnected(true);refresh()}catch(e){status.textContent=e.message;auth=''}};document.querySelector('#add').onsubmit=async e=>{e.preventDefault();try{await api('/api/downloads',{url:document.querySelector('#url').value});document.querySelector('#url').value='';refresh()}catch(e){status.textContent=e.message}};document.querySelector('#logout').onclick=()=>{sessionStorage.removeItem('ff-auth');auth='';showConnected(false)};document.querySelector('#downloads').onclick=async e=>{const b=e.target.closest('button[data-action]');if(!b)return;try{await api('/api/downloads/'+encodeURIComponent(b.dataset.id)+'/action',{action:b.dataset.action});refresh()}catch(e){status.textContent=e.message}};if(auth){showConnected(true);refresh()}setInterval(()=>{if(auth)refresh()},2500);
</script></main></html>`

export async function remoteAccessInfo(): Promise<{
  running: boolean
  port: number
  addresses: string[]
  fingerprint?: string
}> {
  const settings = await loadSettings()
  const config = settings.remoteManagement
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((item) => !item.internal && item.family === 'IPv4')
    .map((item) => `https://${item.address}:${config?.port ?? 8787}`)
  let fingerprint: string | undefined
  if (server) fingerprint = new X509Certificate((await certificate()).cert).fingerprint256
  return {
    running: Boolean(server),
    port: config?.port ?? 8787,
    addresses,
    ...(fingerprint ? { fingerprint } : {})
  }
}

export async function restartRemoteManagement(manager: DownloadManager): Promise<void> {
  managerRef = manager
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
  const config = (await loadSettings()).remoteManagement
  if (!config?.enabled) return
  const saved = await loadCredentials()
  if (!saved || config.username !== saved.username)
    throw new Error(
      'Set and save a remote username and password before enabling remote management.'
    )
  const tls = await certificate()
  const candidate = createServer(tls, async (request, response) => {
    const path = new URL(request.url ?? '/', 'https://localhost').pathname
    if (path === '/' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      })
      response.end(dashboard)
      return
    }
    const address = request.socket.remoteAddress ?? 'unknown'
    const attempts = authFailures.get(address)
    if (attempts && attempts.count >= 8 && Date.now() - attempts.since < 300_000) {
      sendJson(response, 429, { error: 'Too many sign-in attempts. Wait five minutes.' })
      return
    }
    if (!authorized(request.headers.authorization, saved)) {
      const current = authFailures.get(address)
      const inWindow = current && Date.now() - current.since < 300_000
      authFailures.set(address, {
        count: inWindow ? current.count + 1 : 1,
        since: inWindow ? current.since : Date.now()
      })
      response.writeHead(401, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    authFailures.delete(address)
    try {
      if (request.headers['x-fluxfetch-remote'] !== '1') {
        sendJson(response, 403, { error: 'Missing request verification header.' })
        return
      }
      if (path === '/api/downloads' && request.method === 'GET') {
        const rows = await managerRef!.listDownloadStates()
        sendJson(
          response,
          200,
          rows.slice(0, 500).map((state) => ({
            id: state.id,
            fileName: state.fileName,
            status: state.status,
            bytesDownloaded: state.bytesDownloaded,
            totalBytes: state.totalBytes,
            speedBytesPerSec: state.speedBytesPerSec
          }))
        )
        return
      }
      if (path === '/api/downloads' && request.method === 'POST') {
        const body = await readBody(request)
        const raw = String(body.url ?? '')
        let url: URL
        try {
          url = new URL(raw)
        } catch {
          throw new Error('Enter a valid download URL.')
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('Only HTTP and HTTPS URLs without embedded credentials are supported.')
        const settings = await loadSettings()
        await managerRef!.queueDownloads(
          [url.href],
          settings.destinationDir ?? app.getPath('downloads'),
          null
        )
        sendJson(response, 202, { accepted: true })
        return
      }
      const actionMatch = /^\/api\/downloads\/([\w-]+)\/action$/.exec(path)
      if (actionMatch && request.method === 'POST') {
        const body = await readBody(request)
        const id = actionMatch[1]
        if (body.action === 'pause') await managerRef!.pause(id)
        else if (body.action === 'resume') managerRef!.resume(id)
        else if (body.action === 'cancel') await managerRef!.cancel(id)
        else throw new Error('Unknown download action.')
        sendJson(response, 200, { ok: true })
        return
      }
      sendJson(response, 404, { error: 'Not found.' })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise<void>((resolve, reject) => {
    candidate.once('error', reject)
    candidate.listen(config.port, '0.0.0.0', () => {
      candidate.removeListener('error', reject)
      resolve()
    })
  })
  server = candidate
}

export async function stopRemoteManagement(): Promise<void> {
  const current = server
  server = null
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
}
