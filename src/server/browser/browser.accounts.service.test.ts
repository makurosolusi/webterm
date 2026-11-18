import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCOUNT_CHECK_TTL_MS, ACCOUNT_FORCE_FLOOR_MS } from '../../shared/browser.accounts'
import { logBus } from '../logs'
import { createAccountsService } from './browser.accounts.service'
import { createAccountsStore } from './browser.accounts.store'
import { CdpClient } from './cdp.client'
import { startFakeCdp } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

// test-only values: nothing here is a real account or cookie.
const COOKIE_CANARY = 'cookie-value-canary'
const FULL_EMAIL = 'test.person@gmail.com'
const GOOGLE_JSON = JSON.stringify(['gaia.l.a.r', [['gaia.l.a', 1, 'Test Person', FULL_EMAIL, 'https://lh3.googleusercontent.com/a/x', 1, 1, 0, 0, 1, '1', 0, 0, 0, 0, 1]]])

let fake: FakeCdp
let dir: string
afterEach(async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }) })

interface Rig { pages: Record<string, unknown>; cookies: string[]; current: string }
async function setup(over: { live?: boolean; enabled?: boolean; cookies?: string[]; pages?: Record<string, unknown> } = {}) {
  fake = await startFakeCdp()
  dir = mkdtempSync(join(tmpdir(), 'webterm-accounts-'))
  const rig: Rig = {
    current: '',
    cookies: over.cookies ?? ['.google.com', 'github.com'],
    pages: over.pages ?? {
      'accounts.google.com': { url: 'https://accounts.google.com/ListAccounts?x=1', title: '', text: GOOGLE_JSON, userLogin: null, avatar: null },
      'github.com': { url: 'https://github.com/', title: 'GitHub', text: 'hi', userLogin: 'octocat', avatar: null },
    },
  }
  fake.handle('Storage.getCookies', () => ({ cookies: rig.cookies.map((domain) => ({ name: 'sid', value: COOKIE_CANARY, domain, path: '/' })) }))
  fake.handle('Page.navigate', (p) => { rig.current = new URL(String(p.url)).hostname; return {} })
  fake.handle('Runtime.evaluate', (p) => ({ result: { value: String(p.expression).includes('readyState') ? true : JSON.stringify(rig.pages[rig.current]) } }))
  const t = { now: 1_000_000 }
  const acquired: string[] = []
  const changes: number[] = []
  const svc = createAccountsService({
    launcher: { acquire: async (id) => { acquired.push(id); return fake.url }, isLive: () => over.live ?? true },
    connect: (u) => CdpClient.connect(u), guard: (url) => ({ ok: true, url }), store: createAccountsStore(dir),
    enabled: () => over.enabled ?? true, changed: () => { changes.push(t.now) }, now: () => t.now, sleep: async () => undefined,
  })
  const navigated = () => fake.calls.filter((c) => c.method === 'Page.navigate').map((c) => new URL(String(c.params.url)).hostname)
  return { svc, t, rig, acquired, changes, navigated }
}

describe('account check', () => {
  it('reads both providers inside the profile browser and stores only masked data', async () => {
    const { svc, acquired, changes, navigated } = await setup()
    const accounts = await svc.refresh('bp-1')
    expect(acquired).toEqual(['bp-1'])
    expect(navigated().sort()).toEqual(['accounts.google.com', 'github.com'])
    expect(accounts).toEqual([
      { provider: 'github', state: 'signed_in', displayName: 'octocat', checkedAt: 1_000_000 },
      { provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', avatarUrl: 'https://lh3.googleusercontent.com/a/x', checkedAt: 1_000_000 },
    ])
    expect(changes).toHaveLength(1)
    expect(fake.methods().filter((m) => m === 'Target.closeTarget')).toHaveLength(2) // every probe tab is closed
    const file = join(dir, 'browser', 'accounts', 'bp-1.json')
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(FULL_EMAIL)
    expect(raw).not.toContain(COOKIE_CANARY)
  })

  it('never logs more than provider, state and profile id', async () => {
    const before = logBus.query({}).length
    const { svc } = await setup()
    await svc.refresh('bp-1')
    const dump = JSON.stringify(logBus.query({}).slice(before))
    expect(dump).toContain('account check finished')
    for (const secret of [FULL_EMAIL, 'test.person', 'Test Person', 'octocat', COOKIE_CANARY]) expect(dump).not.toContain(secret)
  })

  it('asks no provider when the profile holds no cookie for it: signed out without a request', async () => {
    const { svc, navigated } = await setup({ cookies: ['example.com'] })
    expect((await svc.refresh('bp-1')).map((a) => [a.provider, a.state])).toEqual([['github', 'signed_out'], ['google', 'signed_out']])
    expect(navigated()).toEqual([])
  })

  it('does not run, and never launches a browser, when the profile has no running process or the switch is off', async () => {
    const a = await setup({ live: false })
    expect(await a.svc.refresh('bp-1')).toEqual([])
    expect(a.acquired).toEqual([])
    await fake.close(); rmSync(dir, { recursive: true, force: true })
    const b = await setup({ enabled: false })
    expect(await b.svc.refresh('bp-1')).toEqual([])
    expect(b.svc.get('bp-1')).toEqual([])
    expect(b.acquired).toEqual([])
  })

  it('serial per profile: concurrent triggers share one connection', async () => {
    const { svc, acquired } = await setup()
    svc.trigger('bp-1', 'profile_live')
    svc.trigger('bp-1', 'popover')
    await svc.refresh('bp-1')
    expect(acquired).toHaveLength(1)
  })

  it('TTL: a trigger inside the TTL does nothing, after it the check runs again', async () => {
    const { svc, t, navigated } = await setup()
    await svc.refresh('bp-1')
    const first = navigated().length
    t.now += ACCOUNT_CHECK_TTL_MS - 1
    await svc.refresh('bp-1', { respectTtl: true })
    expect(navigated()).toHaveLength(first)
    t.now += 2
    await svc.refresh('bp-1', { respectTtl: true })
    expect(navigated()).toHaveLength(first * 2)
  })

  it('Refresh skips the TTL but keeps the 15 s floor', async () => {
    const { svc, t, navigated } = await setup()
    await svc.refresh('bp-1')
    const first = navigated().length
    t.now += ACCOUNT_FORCE_FLOOR_MS - 1
    await svc.refresh('bp-1')
    expect(navigated()).toHaveLength(first)
    t.now += 2
    await svc.refresh('bp-1')
    expect(navigated()).toHaveLength(first * 2)
  })

  it('a challenge page gives unknown and backs off exponentially: no retry until the backoff ends', async () => {
    const { svc, t, rig, navigated } = await setup({ cookies: ['github.com'] })
    rig.pages['github.com'] = { url: 'https://github.com/', title: 'Too many requests', text: '', userLogin: null, avatar: null }
    expect((await svc.refresh('bp-1'))[0]).toMatchObject({ provider: 'github', state: 'unknown' })
    expect(navigated()).toHaveLength(1)
    t.now += ACCOUNT_CHECK_TTL_MS + 1 // TTL over, backoff (2 x TTL) not
    await svc.refresh('bp-1', { respectTtl: true })
    await svc.refresh('bp-1')
    expect(navigated()).toHaveLength(1)
    t.now += ACCOUNT_CHECK_TTL_MS * 2
    rig.pages['github.com'] = { url: 'https://github.com/', title: 'GitHub', text: '', userLogin: 'octocat', avatar: null }
    expect((await svc.refresh('bp-1'))[0]).toMatchObject({ state: 'signed_in' })
  })

  it('a failing page leaves the old answer and the other provider intact', async () => {
    const { svc, t, rig } = await setup()
    await svc.refresh('bp-1')
    t.now += ACCOUNT_CHECK_TTL_MS + 1
    fake.handle('Page.navigate', (p) => {
      if (String(p.url).includes('github')) return { __error: { code: -32000, message: 'boom' } }
      rig.current = new URL(String(p.url)).hostname
      return {}
    })
    rig.pages['accounts.google.com'] = { url: 'https://accounts.google.com/ListAccounts', title: '', text: JSON.stringify(['gaia.l.a.r', []]), userLogin: null, avatar: null }
    const out = await svc.refresh('bp-1')
    expect(out.find((a) => a.provider === 'github')).toMatchObject({ state: 'signed_in', displayName: 'octocat' })
    expect(out.find((a) => a.provider === 'google')).toMatchObject({ state: 'signed_out' })
  })

  it('survives a restart through the file and forget() removes it', async () => {
    const { svc } = await setup()
    await svc.refresh('bp-1')
    const again = createAccountsService({
      launcher: { acquire: async () => fake.url }, guard: (url) => ({ ok: true, url }), store: createAccountsStore(dir),
      enabled: () => true, changed: () => undefined,
    })
    expect(again.get('bp-1')).toHaveLength(2)
    again.forget('bp-1')
    expect(createAccountsStore(dir).load('bp-1')).toEqual([])
  })
})
