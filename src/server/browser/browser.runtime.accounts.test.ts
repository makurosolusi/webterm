import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserState } from '../../shared/browser.contract'
import { accountsOn, createAccountsWiring, navigationHit } from './browser.runtime.accounts'
import { CdpClient } from './cdp.client'
import { startFakeCdp, waitFor } from './fakeCdp.testkit'
import type { FakeCdp } from './fakeCdp.testkit'

describe('accountsOn', () => {
  it('is on by default and only an explicit off turns it off', () => {
    expect(accountsOn({})).toBe(true)
    expect(accountsOn({ WEBTERM_BROWSER_ACCOUNTS: 'junk' })).toBe(true)
    expect(accountsOn({ WEBTERM_BROWSER_ACCOUNTS: 'off' })).toBe(false)
  })
})

describe('navigationHit', () => {
  it('ignores pages that are not on a provider host and an unchanged url', () => {
    expect(navigationHit('https://a.example/', 'https://b.example/')).toBeNull()
    expect(navigationHit(undefined, 'about:blank')).toBeNull()
    expect(navigationHit('https://github.com/', 'https://github.com/')).toBeNull()
  })
  it('reaching a provider host is a hit; leaving a login/logout page there is a session change', () => {
    expect(navigationHit('https://a.example/', 'https://github.com/octocat')).toEqual({ sessionChange: false })
    expect(navigationHit('https://github.com/login', 'https://github.com/')).toEqual({ sessionChange: true })
    expect(navigationHit('https://accounts.google.com/v3/signin/x', 'https://myaccount.google.com/')).toEqual({ sessionChange: true })
    expect(navigationHit('https://www.google.com/', 'https://www.google.com/logout')).toEqual({ sessionChange: true })
  })
})

let fake: FakeCdp
let dir: string
afterEach(async () => { await fake?.close(); if (dir) rmSync(dir, { recursive: true, force: true }) })

const state = (over: Partial<BrowserState>): BrowserState =>
  ({ id: 'n1', url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live', ...over })

async function setup() {
  fake = await startFakeCdp()
  dir = mkdtempSync(join(tmpdir(), 'webterm-accwire-'))
  const acquired: string[] = []
  fake.handle('Storage.getCookies', () => ({ cookies: [] })) // no provider cookie: the check ends without a page request
  const launcher = { acquire: async (id: string) => { acquired.push(id); return fake.url }, shutdown: () => undefined, isLive: () => true }
  const t = { now: 1 }
  const w = createAccountsWiring({ env: {}, dataRoot: dir, launcher, connect: (u) => CdpClient.connect(u), guard: (url) => ({ ok: true, url }), now: () => t.now })
  return { w, acquired, t }
}

describe('triggers', () => {
  it('a profile process coming alive triggers one check; a plain state update does not', async () => {
    const { w, acquired, t } = await setup()
    w.onState(state({}), 'bp-1')
    await waitFor(() => acquired.length === 1, 'check on live')
    t.now += 1_000_000
    w.onState(state({ title: 'x' }), 'bp-1')
    await new Promise((r) => setTimeout(r, 30))
    expect(acquired).toHaveLength(1)
  })
  it('a node on a profile-less state or a discarded page triggers nothing', async () => {
    const { w, acquired } = await setup()
    w.onState(state({}), undefined)
    w.onState(state({ live: 'discarded' }), 'bp-1')
    await new Promise((r) => setTimeout(r, 30))
    expect(acquired).toEqual([])
  })
  it('navigating to a provider host after login pages triggers a check once loading stops', async () => {
    const { w, acquired, t } = await setup()
    w.onState(state({ url: 'https://github.com/login' }), 'bp-1')
    await waitFor(() => acquired.length === 1, 'first check')
    t.now += 16_000 // past the 15 s floor, far inside the 10 min TTL
    w.onState(state({ url: 'https://github.com/', loading: true }), 'bp-1')
    await new Promise((r) => setTimeout(r, 30))
    expect(acquired).toHaveLength(1)
    w.onState(state({ url: 'https://github.com/', loading: false }), 'bp-1')
    await waitFor(() => acquired.length === 2, 'session change check')
  })
  it('a cookie import triggers a check after the cookies are in', async () => {
    const { w, acquired } = await setup()
    const order: string[] = []
    const inj = w.wrapInjector({ inject: async () => { order.push('inject') }, remove: async () => undefined })
    await inj.inject('bp-2', [])
    await waitFor(() => acquired.includes('bp-2'), 'check after import')
    expect(order).toEqual(['inject'])
  })
})
