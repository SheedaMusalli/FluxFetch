import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

type AuthHeaders = { cookie?: string; authorization?: string }
type Vault = Record<string, AuthHeaders>

function vaultPath(): string {
  return join(app.getPath('userData'), 'site-auth.bin')
}

function normalizeOrigin(rawOrigin: string): string {
  let url: URL
  try {
    url = new URL(rawOrigin)
  } catch {
    throw new Error('Enter a valid site origin, such as https://example.com.')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Enter only a site origin, without a path or credentials.')
  return url.origin
}

async function readVault(): Promise<Vault> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure credential storage is unavailable.')
  try {
    const parsed = JSON.parse(safeStorage.decryptString(await readFile(vaultPath()))) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Vault = {}
    for (const [origin, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const headers = value as AuthHeaders
      const cookie =
        typeof headers.cookie === 'string' && headers.cookie.length <= 32768 ? headers.cookie : ''
      const authorization =
        typeof headers.authorization === 'string' && headers.authorization.length <= 4096
          ? headers.authorization
          : ''
      if ((cookie || authorization) && !/[\r\n\0]/.test(cookie + authorization))
        result[normalizeOrigin(origin)] = { cookie, authorization }
    }
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeVault(vault: Vault): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const path = vaultPath()
  const temporary = `${path}.tmp`
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(vault)), { mode: 0o600 })
  await rename(temporary, path)
}

export async function listSiteAuthOrigins(): Promise<string[]> {
  return Object.keys(await readVault()).sort()
}

export async function saveSiteAuth(
  rawOrigin: string,
  values: { cookie?: string; authorization?: string; username?: string; password?: string }
): Promise<void> {
  const origin = normalizeOrigin(rawOrigin)
  let authorization = values.authorization?.trim() ?? ''
  if (values.username || values.password) {
    if (!values.username || !values.password || values.username.includes(':'))
      throw new Error('Enter both username and password for Basic authentication.')
    authorization = `Basic ${Buffer.from(`${values.username}:${values.password}`).toString('base64')}`
  }
  const cookie = values.cookie?.trim() ?? ''
  if (
    cookie.length > 32768 ||
    authorization.length > 4096 ||
    /[\r\n\0]/.test(cookie + authorization)
  )
    throw new Error('The authentication value is too long or contains invalid characters.')
  const vault = await readVault()
  if (!cookie && !authorization) delete vault[origin]
  else vault[origin] = { cookie, authorization }
  await writeVault(vault)
}

export async function removeSiteAuth(rawOrigin: string): Promise<void> {
  const vault = await readVault()
  delete vault[normalizeOrigin(rawOrigin)]
  await writeVault(vault)
}

export async function siteAuthContext(
  rawUrl: string
): Promise<{ origin: string; headers: Record<string, string> } | undefined> {
  const url = new URL(rawUrl)
  if (!['http:', 'https:'].includes(url.protocol)) return undefined
  let value: AuthHeaders | undefined
  try {
    value = (await readVault())[url.origin]
  } catch {
    // A damaged credential vault must not prevent public downloads from working.
    return undefined
  }
  if (!value) return undefined
  return {
    origin: url.origin,
    headers: {
      ...(value.cookie ? { cookie: value.cookie } : {}),
      ...(value.authorization ? { authorization: value.authorization } : {})
    }
  }
}
