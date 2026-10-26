import { expect, test } from './fixtures'
import { IpcChannels } from '../src/shared/ipc-channels'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

test.describe('Net Merge controls @smoke', () => {
  test.skip(process.platform !== 'win32', 'Net Merge panel is currently Windows-only')

  test('starts only on request, displays adapters and saves limits and budgets', async ({
    fluxfetch
  }) => {
    await fluxfetch.evaluateMain(({ ipcMain }, channels) => {
      const state = {
        running: false,
        actions: [] as string[],
        limit: null as unknown,
        quota: null as unknown
      }
      ;(globalThis as Record<string, unknown>).__netMergeTest = state
      for (const key of [
        'netMergeStatus',
        'netMergeControl',
        'netMergeLimit',
        'netMergeQuota'
      ] as const) {
        ipcMain.removeHandler(channels[key])
      }
      ipcMain.handle(channels.netMergeStatus, () => ({
        installed: true,
        running: state.running,
        adapters: state.running
          ? [
              {
                Name: 'Mobile tether',
                IP: '10.0.1.2',
                State: 'up',
                Present: true,
                Active: 5,
                BytesIn: 2e9,
                BytesOut: 1e8,
                RateIn: 12.5e6,
                RateOut: 1e6,
                RTTMs: 42,
                LimitMbps: 0,
                PublicIP: '203.0.113.2',
                QuotaBytes: 0,
                QuotaUsed: 0,
                QuotaDaily: false,
                QuotaBlocked: false
              }
            ]
          : []
      }))
      ipcMain.handle(channels.netMergeControl, (_event, action: string) => {
        state.actions.push(action)
        state.running = action === 'start'
      })
      ipcMain.handle(channels.netMergeLimit, (_event, adapter: string, mbps: number) => {
        state.limit = { adapter, mbps }
      })
      ipcMain.handle(channels.netMergeQuota, (_event, quota: unknown) => {
        state.quota = quota
      })
    }, IpcChannels)
    const page = fluxfetch.page
    await expect(page.getByRole('button', { name: 'Run OmniLink', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Net Merge', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    expect(
      await fluxfetch.evaluateMain(
        () =>
          (globalThis as unknown as Record<string, { actions: string[] }>).__netMergeTest.actions,
        null
      )
    ).toEqual([])
    await dialog.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(dialog.getByText('Merging connections', { exact: true })).toBeVisible()
    await expect(dialog.getByText('100.0 Mbit/s', { exact: true })).toBeVisible()
    await expect(dialog.getByText('42 ms', { exact: true })).toBeVisible()
    await page.screenshot({ path: 'artifacts/net-merge-panel.png' })
    await dialog.getByLabel('Speed limit (Mbit/s)').fill('20')
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect
      .poll(() =>
        fluxfetch.evaluateMain(
          () => (globalThis as unknown as Record<string, { limit: unknown }>).__netMergeTest.limit,
          null
        )
      )
      .toEqual({ adapter: 'Mobile tether', mbps: 20 })
    await dialog.getByLabel('Data budget (GB)').fill('2.5')
    await dialog.getByRole('button', { name: 'Save budget', exact: true }).click()
    await expect
      .poll(() =>
        fluxfetch.evaluateMain(
          () => (globalThis as unknown as Record<string, { quota: unknown }>).__netMergeTest.quota,
          null
        )
      )
      .toEqual({ adapter: 'Mobile tether', gb: 2.5, daily: true, reset: false })
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()
  })

  test('shows missing engine and keeps launch errors visible', async ({ fluxfetch }) => {
    await fluxfetch.evaluateMain(({ ipcMain }, channels) => {
      ipcMain.removeHandler(channels.netMergeStatus)
      ipcMain.handle(channels.netMergeStatus, () => ({
        installed: false,
        running: false,
        adapters: []
      }))
    }, IpcChannels)
    await fluxfetch.page.getByRole('button', { name: 'Net Merge', exact: true }).click()
    const dialog = fluxfetch.page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
    await expect(dialog.getByText(/The Net Merge engine is missing/)).toBeVisible()
    await fluxfetch.evaluateMain(({ ipcMain }, channels) => {
      ipcMain.removeHandler(channels.netMergeStatus)
      ipcMain.removeHandler(channels.netMergeControl)
      ipcMain.handle(channels.netMergeStatus, () => ({
        installed: true,
        running: false,
        adapters: []
      }))
      ipcMain.handle(channels.netMergeControl, () => {
        throw new Error('Quit OmniLink from its tray menu before starting Net Merge.')
      })
    }, IpcChannels)
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Quit OmniLink')
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
  })

  test('rejects malformed IPC arguments and ignores stale engine status', async ({ fluxfetch }) => {
    const errorFor = async (
      method: 'netMergeControl' | 'netMergeLimit' | 'netMergeQuota',
      args: unknown[]
    ): Promise<string> =>
      fluxfetch.page.evaluate(
        async ({ method, args }) => {
          try {
            await (window.fluxfetch[method] as (...values: unknown[]) => Promise<unknown>)(...args)
            return ''
          } catch (error) {
            return String(error)
          }
        },
        { method, args }
      )
    expect(await errorFor('netMergeControl', ['install-driver'])).toContain(
      'Invalid Net Merge action'
    )
    expect(await errorFor('netMergeLimit', ['tether', -1])).toContain('valid adapter')
    expect(
      await errorFor('netMergeQuota', [{ adapter: 'tether', gb: -1, daily: true, reset: false }])
    ).toContain('valid data budget')
    const dir = join(fluxfetch.dirs.userData, 'net-merge')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'status.json'),
      JSON.stringify({
        Mode: 'system-wide',
        Updated: new Date(Date.now() - 10000).toISOString(),
        NICs: [{ Name: 'stale' }]
      })
    )
    const status = await fluxfetch.page.evaluate(() => window.fluxfetch.netMergeStatus())
    expect(status.running).toBe(false)
    expect(status.adapters).toEqual([])
  })

  test('keeps Stop available for an unresponsive live engine and writes its real control marker', async ({
    fluxfetch
  }) => {
    const dir = join(fluxfetch.dirs.userData, 'net-merge')
    await mkdir(dir, { recursive: true })
    const pid = await fluxfetch.evaluateMain(() => process.pid, null)
    await writeFile(
      join(dir, 'status.json'),
      JSON.stringify({
        PID: pid,
        Mode: 'system-wide',
        Updated: new Date(Date.now() - 10000).toISOString(),
        NICs: []
      })
    )
    const status = await fluxfetch.api.netMergeStatus()
    expect(status.running).toBe(true)
    expect(status.phase).toBe('unresponsive')
    await fluxfetch.page.getByRole('button', { name: 'Net Merge', exact: true }).click()
    const dialog = fluxfetch.page.getByRole('dialog')
    await expect(dialog.getByText('Engine status stopped updating', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect
      .poll(() =>
        readFile(join(dir, 'ctl/off'), 'utf8').then(
          () => true,
          () => false
        )
      )
      .toBe(true)
    await unlink(join(dir, 'status.json'))
    await expect(dialog.getByText('Ready when you are', { exact: true })).toBeVisible()
  })

  test('sanitizes real status files and rejects a dead process despite a fresh heartbeat', async ({
    fluxfetch
  }) => {
    const dir = join(fluxfetch.dirs.userData, 'net-merge')
    await mkdir(dir, { recursive: true })
    const pid = await fluxfetch.evaluateMain(() => process.pid, null)
    const file = join(dir, 'status.json')
    await writeFile(
      file,
      JSON.stringify({
        PID: pid,
        Mode: 'system-wide',
        Updated: new Date().toISOString(),
        NICs: [
          null,
          12,
          { Name: 'bad adapter', Present: true, RateIn: 'unexpected', RTTMs: null },
          { Name: 123 }
        ]
      })
    )
    const status = await fluxfetch.api.netMergeStatus()
    expect(status.phase).toBe('running')
    expect(status.adapters).toHaveLength(1)
    expect(status.adapters[0].RateIn).toBe(0)
    expect(status.adapters[0].RTTMs).toBe(0)
    await fluxfetch.page.getByRole('button', { name: 'Net Merge', exact: true }).click()
    await expect(
      fluxfetch.page.getByRole('dialog').getByText('bad adapter', { exact: true })
    ).toBeVisible()
    await writeFile(
      file,
      JSON.stringify({
        PID: 2147483647,
        Mode: 'system-wide',
        Updated: new Date().toISOString(),
        NICs: []
      })
    )
    expect((await fluxfetch.api.netMergeStatus()).phase).toBe('stopped')
  })

  test('shows shared-WAN and quota-storage warnings inside a compact window', async ({
    fluxfetch
  }) => {
    await fluxfetch.evaluateMain(({ ipcMain, BrowserWindow }, channels) => {
      BrowserWindow.getAllWindows()[0].setSize(720, 650)
      ipcMain.removeHandler(channels.netMergeStatus)
      ipcMain.handle(channels.netMergeStatus, () => ({
        installed: true,
        phase: 'running',
        running: true,
        adapters: ['Ethernet', 'Phone'].map((Name) => ({
          Name,
          IP: '192.168.1.2',
          State: 'up',
          Present: true,
          Active: 0,
          BytesIn: 0,
          BytesOut: 0,
          RateIn: 0,
          RateOut: 0,
          RTTMs: 10,
          LimitMbps: 0,
          PublicIP: '203.0.113.1',
          QuotaBytes: 0,
          QuotaUsed: 0,
          QuotaDaily: false,
          QuotaBlocked: true,
          QuotaError: 'Test disk error'
        }))
      }))
    }, IpcChannels)
    await fluxfetch.page.getByRole('button', { name: 'Net Merge', exact: true }).click()
    const dialog = fluxfetch.page.getByRole('dialog')
    await expect(dialog.getByText(/Some adapters report the same public IP/)).toBeVisible()
    await expect(dialog.getByRole('alert').first()).toContainText('Budget storage failed')
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650)
    const lastNotice = dialog.getByText(/Public-IP diagnostics contact Cloudflare/)
    await lastNotice.scrollIntoViewIfNeeded()
    await expect(lastNotice).toBeInViewport()
  })
})
