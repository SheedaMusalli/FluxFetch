import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

interface TorrentClientConfig {
  baseUrl: string
  username: string
  password: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'torrent-client.bin')
}

function validateBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter the qBittorrent WebUI address, such as http://127.0.0.1:8080.')
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (!['http:', 'https:'].includes(url.protocol) || !localHosts.has(url.hostname.toLowerCase())) {
    throw new Error('For safety, FluxFetch connects only to qBittorrent running on this PC.')
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Put qBittorrent credentials in their fields, not in the address.')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

export async function saveTorrentClientConfig(input: TorrentClientConfig): Promise<void> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows credential encryption is unavailable.')
  const config: TorrentClientConfig = {
    baseUrl: validateBaseUrl(input.baseUrl).href,
    username: input.username.trim(),
    password: input.password
  }
  if (
    !config.username ||
    !config.password ||
    config.username.length > 128 ||
    config.password.length > 512
  )
    throw new Error('Enter a qBittorrent WebUI username and password.')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(configPath(), safeStorage.encryptString(JSON.stringify(config)), { mode: 0o600 })
}

async function loadConfig(): Promise<TorrentClientConfig> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows credential encryption is unavailable.')
  try {
    const config = JSON.parse(
      safeStorage.decryptString(await readFile(configPath()))
    ) as TorrentClientConfig
    return { ...config, baseUrl: validateBaseUrl(config.baseUrl).href }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Configure qBittorrent WebUI in FluxFetch settings first.')
    throw error
  }
}

async function request(
  config: TorrentClientConfig,
  path: string,
  method: 'GET' | 'POST',
  body?: URLSearchParams,
  cookie?: string
): Promise<Response> {
  const base = validateBaseUrl(config.baseUrl)
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      Referer: base.href,
      Origin: base.origin,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body,
    signal: AbortSignal.timeout(10000)
  })
  return response
}

async function login(
  config: TorrentClientConfig
): Promise<{ config: TorrentClientConfig; cookie: string }> {
  const response = await request(
    config,
    'api/v2/auth/login',
    'POST',
    new URLSearchParams({ username: config.username, password: config.password })
  )
  if (!response.ok || (await response.text()) !== 'Ok.')
    throw new Error(
      'Could not sign in to qBittorrent. Check that WebUI is enabled and credentials are correct.'
    )
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('qBittorrent did not return its login session cookie.')
  return { config, cookie }
}

export async function testTorrentClient(): Promise<string> {
  const session = await login(await loadConfig())
  const response = await request(
    session.config,
    'api/v2/app/version',
    'GET',
    undefined,
    session.cookie
  )
  if (!response.ok) throw new Error(`qBittorrent returned HTTP ${response.status}.`)
  return `Connected to qBittorrent ${await response.text()}`
}

export async function addTorrentUrl(
  rawUrl: string,
  savePath: string,
  downloadLimitBytesPerSecond = 0
): Promise<void> {
  const url = new URL(rawUrl)
  if (!(url.protocol === 'magnet:' || url.protocol === 'http:' || url.protocol === 'https:'))
    throw new Error('Only magnet links and HTTP/HTTPS .torrent links are supported.')
  if (url.href.length > 32768 || url.username || url.password)
    throw new Error('Invalid torrent address.')
  const session = await login(await loadConfig())
  const form = new URLSearchParams({ urls: url.href, savepath: savePath })
  if (downloadLimitBytesPerSecond > 0)
    form.set('dlLimit', String(Math.floor(downloadLimitBytesPerSecond)))
  const response = await request(
    session.config,
    'api/v2/torrents/add',
    'POST',
    form,
    session.cookie
  )
  if (!response.ok)
    throw new Error(`qBittorrent could not add the torrent (HTTP ${response.status}).`)
  const result = (await response.text()).trim()
  if (result.toLowerCase().includes('fail'))
    throw new Error(`qBittorrent rejected the torrent: ${result}`)
}
