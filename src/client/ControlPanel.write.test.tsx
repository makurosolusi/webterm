/**
 * @vitest-environment jsdom
 */
// Control tab end to end against the REAL server route + env-settings service (in memory): the A2 drift
// check over the full registry (every Control-owned key renders an editor), a write changing the
// effective value, the shell-env lock, and a Doctor fix.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DoctorDeps } from '../server/doctor'
import { CONTROL_WHERE } from '../server/effectiveConfig.ui'
import { ENV_REGISTRY } from '../server/envRegistry'
import { controlEffectiveRoute, type ControlDeps } from '../server/envSettings.control'
import { fakeReq, recorder, setupEnv } from '../server/envSettings.testutil'
import { ControlPanel } from './ControlPanel'

function serve(env: NodeJS.ProcessEnv = {}, doctor: Partial<DoctorDeps> = {}) {
  const s = setupEnv(env)
  const deps: ControlDeps = {
    service: s.svc, env: s.target, dotenvKeys: new Set(), rootToken: null, guard: () => ({ ok: true, via: 'ui' }), audit: () => {},
    doctor: () => ({
      onPath: () => true, claudeReady: async () => ({ ok: true }), opencodeBin: 'opencode', opencodeReady: async () => ({ ok: true }),
      generated: () => [], readFile: () => null, installGenerated: () => {}, telegram: async () => ({ state: 'unset' }),
      sandbox: () => ({ on: true, supported: true }), setSandbox: () => {}, looseDirs: () => [], tightenDirs: () => {},
      verifyLedger: () => null, ...doctor,
    }),
  }
  const puts: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const doctorPath = url.startsWith('/api/control/doctor')
    if (!url.startsWith('/api/control/effective') && !doctorPath) return new Response('{"error":"not_found"}', { status: 404 })
    const method = init.method ?? 'GET'
    if (method === 'PUT') puts.push(JSON.parse(String(init.body)))
    const res = recorder()
    await controlEffectiveRoute(Object.assign(fakeReq(method, init.body as string | undefined), { url, headers: {} }), res, method, deps, doctorPath)
    return new Response(res.body, { status: res.status })
  }))
  return { ...s, puts }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const rowEl = (key: string): HTMLElement => document.querySelector(`[data-key="${key}"]`) as HTMLElement

describe('Control tab writes', () => {
  it('A2: every Control-owned registry key renders a live editor (no env-only behaviour key)', async () => {
    serve()
    render(<ControlPanel />)
    await screen.findByRole('region', { name: 'Logs' })
    const owned = ENV_REGISTRY.filter((s) => rowEl(s.key)?.textContent?.includes('Managed in') !== true).map((s) => s.key)
    expect(owned.length).toBeGreaterThanOrEqual(38) // the former ENV_ONLY_PENDING_F1 list, minus WEBTERM_CENTRAL_MAX_STEPS (K7)
    const missing = owned.filter((k) => document.querySelector(`[data-control="${k}"]`) === null)
    expect(missing).toEqual([])
    for (const k of ['WEBTERM_AGENT_SANDBOX', 'WEBTERM_LEDGER', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'WEBTERM_CENTRAL_MODEL']) expect(owned).toContain(k)
    expect(rowEl('WEBTERM_CENTRAL').textContent).toContain('Managed in Settings › Capabilities › Central agent')
    expect(CONTROL_WHERE).toBe('Settings › Control')
  })

  it('toggling a hot flag writes it and the effective value updates in place', async () => {
    const s = serve()
    render(<ControlPanel />)
    await screen.findByRole('region', { name: 'Logs' })
    expect(rowEl('WEBTERM_AGENT_SANDBOX').textContent).toContain('Applies to new sessions')
    fireEvent.click(screen.getByLabelText('Agent sandbox'))
    await waitFor(() => expect(rowEl('WEBTERM_AGENT_SANDBOX').getAttribute('data-modified')).toBe('true'))
    expect(s.puts).toEqual([{ set: { WEBTERM_AGENT_SANDBOX: 'off' }, unset: [] }])
    expect(s.target['WEBTERM_AGENT_SANDBOX']).toBe('off')
    fireEvent.click(rowEl('WEBTERM_AGENT_SANDBOX').querySelector('button[title^="Reset"]') as HTMLElement)
    await waitFor(() => expect(rowEl('WEBTERM_AGENT_SANDBOX').hasAttribute('data-modified')).toBe(false))
  })

  it('a number is committed on Enter; a boot knob says it needs a server restart; bad input is reported', async () => {
    serve()
    render(<ControlPanel />)
    await screen.findByRole('region', { name: 'Logs' })
    const input = rowEl('WEBTERM_LOG_BUFFER').querySelector('input') as HTMLInputElement
    expect(rowEl('WEBTERM_LOG_BUFFER').textContent).toContain('Needs a restart of the webterm server.')
    fireEvent.change(input, { target: { value: '900' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(rowEl('WEBTERM_LOG_BUFFER').textContent).toContain('Saved; restart the webterm server to apply.'))
    const max = rowEl('WEBTERM_FILES_LIST_MAX').querySelector('input') as HTMLInputElement
    fireEvent.change(max, { target: { value: '-5' } })
    fireEvent.blur(max)
    expect((await screen.findByRole('alert')).textContent).toContain('Not saved')
  })

  it('a key set in the shell environment is locked with the reason and has no editor', async () => {
    serve({ WEBTERM_LOG_LEVEL: 'debug' })
    render(<ControlPanel />)
    await screen.findByRole('region', { name: 'Logs' })
    expect(document.querySelector('[data-control="WEBTERM_LOG_LEVEL"]')).toBeNull()
    expect(rowEl('WEBTERM_LOG_LEVEL').textContent).toContain('Locked: Set in the shell environment')
  })

  it('Doctor: a failing check offers Fix, and the re-run result replaces it', async () => {
    let tight = false
    serve({}, { looseDirs: () => (tight ? [] : ['/data']), tightenDirs: () => { tight = true } })
    render(<ControlPanel />)
    const fix = await screen.findByRole('button', { name: 'Restrict to 0700' })
    expect(document.querySelector('[data-check="dataDir"]')?.getAttribute('data-status')).toBe('fail')
    fireEvent.click(fix)
    await waitFor(() => expect(document.querySelector('[data-check="dataDir"]')?.getAttribute('data-status')).toBe('ok'))
    expect(screen.queryByRole('button', { name: 'Restrict to 0700' })).toBeNull()
  })
})
