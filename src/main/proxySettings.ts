import { Agent as HttpAgent } from 'node:http'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

const proxyPath = (): string => join(app.getPath('userData'), 'proxy-settings.bin')

export async function loadProxyUrl(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const value = safeStorage.decryptString(await readFile(proxyPath()))
    return validateProxyUrl(value).href
  } catch {
    return null
  }
}

function validateProxyUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('Enter a complete proxy address, including its protocol and port.')
  }
  if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol))
    throw new Error('Supported proxy protocols are HTTP, HTTPS, SOCKS4, and SOCKS5.')
  if (!url.hostname || !url.port || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Enter a proxy hostname and port only.')
  return url
}

export async function saveProxyConfig(
  server: string,
  username: string,
  password: string
): Promise<void> {
  if (!server.trim()) {
    await rm(proxyPath(), { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable())
    throw new Error(
      'Windows credential encryption is unavailable; the proxy password cannot be saved securely.'
    )
  const url = validateProxyUrl(server)
  if ((url.protocol === 'socks4:' || url.protocol === 'socks4a:') && password)
    throw new Error(
      'SOCKS4 supports a user ID but not a password. Use SOCKS5 if your proxy requires both.'
    )
  if ((username && !password) || (!username && password))
    throw new Error('Enter both proxy username and password, or leave both blank.')
  if (username.length > 256 || password.length > 256)
    throw new Error('Proxy credentials are too long.')
  url.username = username
  url.password = password
  await writeFile(proxyPath(), safeStorage.encryptString(url.href), { mode: 0o600 })
}

export function createProxyAgent(proxyUrl: string, localAddress?: string): HttpAgent {
  const url = validateProxyUrl(proxyUrl)
  const options = localAddress ? { localAddress } : undefined
  if (url.protocol.startsWith('socks')) return new SocksProxyAgent(url, options)
  if (url.protocol === 'https:') return new HttpsProxyAgent(url, options)
  return new HttpProxyAgent(url, options)
}

export function displayProxyAddress(proxyUrl: string | null): string {
  if (!proxyUrl) return ''
  const url = new URL(proxyUrl)
  url.username = ''
  url.password = ''
  return url.href
}
