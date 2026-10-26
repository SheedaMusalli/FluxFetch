import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NetMergeAdapter, NetMergeQuotaRequest, NetMergeStatus } from '../shared/netMerge'

const directory = (): string => join(app.getPath('userData'), 'net-merge')
const executable = (): string =>
  join(
    app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
    'net-merge',
    'net-merge.exe'
  )
let pending = false
let quotaPending = false
let omniLaunching = false

export async function guardOmniLinkLaunch(launch: () => Promise<void>): Promise<void> {
  if (pending || omniLaunching)
    throw new Error('Another network engine action is still in progress.')
  omniLaunching = true
  try {
    if ((await netMergeStatus()).running)
      throw new Error('Stop Net Merge before starting OmniLink.')
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "if (Get-Process -Name 'net-merge','net-merge-tray' -ErrorAction SilentlyContinue) { exit 10 }"
        ],
        { windowsHide: true, timeout: 10_000 },
        (error) =>
          error
            ? reject(new Error('Stop Net Merge and close its tray before starting OmniLink.'))
            : resolve()
      )
    })
    await launch()
  } finally {
    omniLaunching = false
  }
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable(),
      args,
      { windowsHide: true, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve()
      }
    )
  })
}

export async function netMergeStatus(): Promise<NetMergeStatus> {
  const installed =
    process.platform === 'win32' &&
    (await stat(executable()).then(
      (s) => s.isFile(),
      () => false
    )) &&
    (await stat(join(executable(), '..', 'wintun.dll')).then(
      (s) => s.isFile(),
      () => false
    ))
  try {
    const statusPath = join(directory(), 'status.json')
    if ((await stat(statusPath)).size > 1_048_576) throw new Error('Engine status is too large.')
    const data = JSON.parse(await readFile(statusPath, 'utf8'))
    if (!data || typeof data !== 'object') throw new Error('Invalid engine status.')
    const age = Date.now() - Date.parse(data.Updated)
    let alive = false
    if (Number.isSafeInteger(data.PID) && data.PID > 0) {
      try {
        process.kill(data.PID, 0)
        alive = true
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    const knownMode = data.Mode === 'system-wide' || data.Mode === 'starting'
    const fresh = age >= -2000 && age < 4000
    const phase: NetMergeStatus['phase'] =
      !alive || !knownMode
        ? 'stopped'
        : !fresh
          ? 'unresponsive'
          : data.Mode === 'starting'
            ? 'starting'
            : 'running'
    const adapters: NetMergeAdapter[] = []
    if (phase !== 'stopped' && Array.isArray(data.NICs)) {
      for (const entry of data.NICs.slice(0, 256)) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.Name !== 'string' ||
          !entry.Name ||
          entry.Name.length > 256
        )
          continue
        const numeric = (key: string): number =>
          typeof entry[key] === 'number' && Number.isFinite(entry[key]) && entry[key] >= 0
            ? entry[key]
            : 0
        const string = (key: string): string =>
          typeof entry[key] === 'string' ? entry[key].slice(0, 512) : ''
        adapters.push({
          Name: entry.Name,
          IP: string('IP'),
          State: string('State'),
          Present: entry.Present === true,
          Active: numeric('Active'),
          BytesIn: numeric('BytesIn'),
          BytesOut: numeric('BytesOut'),
          RateIn: numeric('RateIn'),
          RateOut: numeric('RateOut'),
          RTTMs: numeric('RTTMs'),
          LimitMbps: numeric('LimitMbps'),
          PublicIP: string('PublicIP'),
          QuotaBytes: numeric('QuotaBytes'),
          QuotaUsed: numeric('QuotaUsed'),
          QuotaDaily: entry.QuotaDaily === true,
          QuotaBlocked: entry.QuotaBlocked === true,
          QuotaError: string('QuotaError')
        })
      }
    }
    return { installed, running: phase !== 'stopped', phase, adapters }
  } catch {
    return { installed, running: false, phase: 'stopped', adapters: [] }
  }
}

export async function netMergeControl(action: 'start' | 'stop'): Promise<void> {
  if (action !== 'start' && action !== 'stop') throw new Error('Invalid Net Merge action.')
  if (process.platform !== 'win32')
    throw new Error('Net Merge integration is currently available on Windows.')
  if (pending) throw new Error('Net Merge is still completing the previous action.')
  if (action === 'start' && omniLaunching)
    throw new Error('OmniLink is still starting. Quit it before starting Net Merge.')
  pending = true
  try {
    const status = await netMergeStatus()
    if (action === 'start' && status.phase === 'running') return
    if (action === 'start' && status.phase === 'unresponsive')
      throw new Error(
        'Net Merge is still running but its status stopped updating. Press Stop before starting again.'
      )
    if (action === 'start' && !status.running) {
      if (!status.installed)
        throw new Error(
          'Net Merge files are missing. Run npm run build:net-merge, or reinstall FluxFetch.'
        )
      // Two packet-routing engines must not compete for the same traffic.
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "if (Get-Process -Name 'omnilink-tray' -ErrorAction SilentlyContinue) { exit 10 }"
          ],
          { windowsHide: true, timeout: 10_000 },
          (error) =>
            error
              ? reject(new Error('Quit OmniLink from its tray menu before starting Net Merge.'))
              : resolve()
        )
      })
      await mkdir(directory(), { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          executable(),
          ['run', '-hidden', '-state-dir', directory(), '-log', join(directory(), 'engine.log')],
          { windowsHide: true, detached: true, stdio: 'ignore' }
        )
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      })
    } else if (action === 'stop') {
      await mkdir(join(directory(), 'ctl'), { recursive: true })
      await writeFile(join(directory(), 'ctl', 'off'), '')
    }
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const next = await netMergeStatus()
      if (action === 'start' ? next.phase === 'running' : next.phase === 'stopped') return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error(
      action === 'start'
        ? 'Net Merge did not start. Approve the Windows administrator prompt and check engine.log in FluxFetch’s net-merge data folder. Another Net Merge instance may already be running.'
        : 'Net Merge has not confirmed shutdown. Try Stop again.'
    )
  } finally {
    pending = false
  }
}

export async function netMergeLimit(adapter: string, mbps: number): Promise<void> {
  if (
    typeof adapter !== 'string' ||
    !adapter.trim() ||
    adapter.length > 256 ||
    Array.from(adapter).some((character) => character.charCodeAt(0) < 32) ||
    typeof mbps !== 'number' ||
    !Number.isFinite(mbps) ||
    mbps < 0 ||
    mbps > 100_000
  ) {
    throw new Error('Enter a valid adapter and a speed limit from 0 to 100,000 Mbit/s.')
  }
  const status = await netMergeStatus()
  if (!status.running || !status.adapters.some((n) => n.Name === adapter && n.Present)) {
    throw new Error('This adapter is no longer available in Net Merge.')
  }
  await run(['limit', '-state-dir', directory(), '--', adapter, String(mbps)])
}

export async function netMergeQuota(request: NetMergeQuotaRequest): Promise<void> {
  if (
    !request ||
    typeof request.adapter !== 'string' ||
    !request.adapter.trim() ||
    request.adapter.length > 256 ||
    typeof request.gb !== 'number' ||
    !Number.isFinite(request.gb) ||
    request.gb < 0 ||
    request.gb > 1_000_000 ||
    typeof request.daily !== 'boolean' ||
    typeof request.reset !== 'boolean'
  ) {
    throw new Error('Enter a valid data budget from 0 to 1,000,000 GB.')
  }
  if (quotaPending) throw new Error('Another data budget change is still being saved.')
  quotaPending = true
  try {
    const status = await netMergeStatus()
    if (!status.running || !status.adapters.some((n) => n.Name === request.adapter && n.Present)) {
      throw new Error('Start Net Merge and select an available adapter first.')
    }
    const id = randomUUID()
    const path = join(directory(), 'ctl', 'quota')
    await mkdir(join(directory(), 'ctl'), { recursive: true })
    await writeFile(
      path + '.tmp',
      JSON.stringify({ ...request, bytes: Math.round(request.gb * 1e9), id })
    )
    await rename(path + '.tmp', path)
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const result = await readFile(join(directory(), 'quota-result.json'), 'utf8').then(
        (text) => {
          try {
            return JSON.parse(text)
          } catch {
            return null
          }
        },
        () => null
      )
      if (result?.id === id) {
        if (result.error) throw new Error(String(result.error))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('Net Merge did not confirm the budget change. Check that it is still running.')
  } finally {
    quotaPending = false
  }
}
