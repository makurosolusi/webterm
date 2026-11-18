/** @vitest-environment jsdom */
// The limit toast: "Raise limit to N+1" (one step, applied through the env PUT), "Settings" (opens Settings > Browser),
// no raise button at the range maximum, "Try again" after a raise.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENV_BROWSER, MAX_LIVE_RANGE } from '../shared/browser.contract'
import { LIMIT_NOTICE_TEXT, showLimitNotice } from './browserLimit.notice'
import type { WorkspaceNotice } from './workspaceSave.notice'

const hoisted = vi.hoisted(() => ({ show: vi.fn(), open: vi.fn() }))
vi.mock('./workspaceSave.notice', () => ({ showNotice: hoisted.show }))
vi.mock('./appRoute', () => ({ appNavigate: () => ({ openSettings: hoisted.open }) }))

let puts: { set: Record<string, string>; unset: string[] }[]
let status: number
const lastNotice = (): WorkspaceNotice => hoisted.show.mock.calls.at(-1)?.[1] as WorkspaceNotice
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  puts = []; status = 3; hoisted.show.mockReset(); hoisted.open.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) }
    if (url.startsWith('/api/browser/status')) return new Response(JSON.stringify({ enabled: true, binFound: true, live: 3, maxLive: status, agentEnabled: true, cookieImportEnabled: true }))
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('showLimitNotice', () => {
  it('offers Raise limit to 4 and Settings; Raise writes one step, then offers Try again', async () => {
    const retry = vi.fn()
    await showLimitNotice('k', 'warning', 'No browser opened.', { max: 3, retry })
    const n = lastNotice()
    expect(n.actions?.map((a) => a.label)).toEqual([LIMIT_NOTICE_TEXT.raise(4), 'Settings'])
    n.actions?.[0].onClick()
    await flush()
    expect(puts).toEqual([{ set: { [ENV_BROWSER.maxLive]: '4' }, unset: [] }])
    const after = lastNotice()
    expect(after.title).toBe(LIMIT_NOTICE_TEXT.raised(4))
    after.actions?.[0].onClick()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('Settings opens Settings > Browser on the limit row', async () => {
    await showLimitNotice('k', 'warning', 'x', { max: 3 })
    lastNotice().actions?.at(-1)?.onClick()
    expect(hoisted.open).toHaveBeenCalledWith('browser', 'browser-limit')
  })

  it('has no raise button at the range maximum and names Settings in the text', async () => {
    await showLimitNotice('k', 'warning', 'No browser opened.', { max: MAX_LIVE_RANGE.max })
    const n = lastNotice()
    expect(n.actions?.map((a) => a.label)).toEqual(['Settings'])
    expect(n.title).toContain('Settings')
  })

  it('reads the limit from the server when the caller does not know it', async () => {
    status = 5
    await showLimitNotice('k', 'warning', 'Too many.')
    expect(lastNotice().actions?.[0].label).toBe(LIMIT_NOTICE_TEXT.raise(6))
  })

  it('reports a failed raise with a Settings way out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })))
    await showLimitNotice('k', 'warning', 'x', { max: 3 })
    lastNotice().actions?.[0].onClick()
    await flush()
    expect(lastNotice()).toMatchObject({ severity: 'error', title: LIMIT_NOTICE_TEXT.raiseFailed })
  })
})
