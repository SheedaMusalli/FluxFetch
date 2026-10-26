import { execSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'

/** Validate a distinct source address for the network fixtures. These exercise socket binding,
 * accounting and simulated interface changes; they do not measure physical WAN aggregation. */
async function findLanAddress(): Promise<string> {
  const candidates = Object.values(networkInterfaces())
    .flat()
    .filter(
      (addr) => addr?.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')
    )
    .map((addr) => addr!.address)
  // Windows may reject a LAN-bound source connecting to loopback while allowing
  // distinct addresses within 127/8. The server must observe the requested source.
  candidates.push('127.0.0.2')

  const server = createServer((req, res) => res.end(req.socket.remoteAddress))
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address() as AddressInfo
  try {
    for (const candidate of new Set(candidates)) {
      const works = await new Promise<boolean>((resolve) => {
        const req = request(
          { host: '127.0.0.1', port, localAddress: candidate, family: 4 },
          (res) => {
            let observed = ''
            res.on('data', (chunk) => {
              observed += String(chunk)
            })
            res.on('end', () => resolve(res.statusCode === 200 && observed === candidate))
            res.on('error', () => resolve(false))
          }
        )
        req.setTimeout(2000, () => req.destroy())
        req.on('error', () => resolve(false))
        req.end()
      })
      if (works) return candidate
    }
    return ''
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Tests launch the built app (out/), so build it first — a stale build tests stale code.
 * FLUXFETCH_E2E_SKIP_BUILD=1 skips it when the build is known to be fresh (e.g. a CI step). */
export default async function globalSetup(): Promise<void> {
  process.env.FLUXFETCH_E2E_LAN ??= await findLanAddress()
  if (process.env.FLUXFETCH_E2E_LAN) {
    const address = process.env.FLUXFETCH_E2E_LAN
    console.log(
      `E2E second source: ${address} (${address.startsWith('127.') ? 'loopback socket fixture' : 'LAN socket fixture'})`
    )
  }
  if (process.env.FLUXFETCH_E2E_SKIP_BUILD === '1') return
  execSync('npx electron-vite build', { stdio: 'inherit' })
}
