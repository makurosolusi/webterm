// /api/browser/profiles: `accounts` in the list and POST /:id/accounts/refresh (human-only route, TTL flag, 404 for an unknown profile).
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProfileAccount } from '../shared/browser.accounts'
import type { BrowserProfile } from '../shared/browser.profile'
import type { BrowserStatusResp } from '../shared/browser.contract'
import { handleBrowserApi } from './browserApi'
import type { BrowserApiDeps } from './browserApi'
import { createCookiePreviewStore } from './browser/cookieImport.preview'
import { makeRig } from './browser/browser.profiles.testkit'
import type { Rig } from './browser/browser.profiles.testkit'
import { removeProfile } from './browser/browser.profiles.ops'

const ACCOUNT: ProfileAccount = { provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', checkedAt: 7 } // test-only
let rig: Rig
let d: BrowserApiDeps
let asked: Array<{ id: string; respectTtl?: boolean }>
let known: ProfileAccount[]

const status = (): BrowserStatusResp => ({ enabled: true, binFound: true, live: 0, maxLive: 3, agentEnabled: true, cookieImportEnabled: true })
const api = (method: string, path: string, search = '') =>
  handleBrowserApi(method, `/api/browser/profiles${path}`, () => Promise.resolve(''), d, new URLSearchParams(search))

beforeEach(() => {
  rig = makeRig()
  rig.svc.ensureDefaults()
  asked = []
  known = [ACCOUNT]
  rig.svc.deps.accounts = () => known
  const accounts = {
    get: () => known, trigger: () => undefined, forget: () => undefined,
    refresh: async (id: string, opts?: { respectTtl?: boolean }) => { asked.push({ id, respectTtl: opts?.respectTtl }); return known },
  }
  d = {
    status, vault: rig.vault, preview: createCookiePreviewStore(),
    injector: { inject: async () => undefined, remove: async () => undefined },
    lease: { holder: () => 'human', takeover: () => undefined, release: () => undefined },
    setAgentControl: () => undefined, profiles: { profiles: rig.svc, ops: rig.ops, accounts },
    setNodeProfile: async () => ({ ok: false, code: 'profile_not_found' }),
  }
})

describe('accounts in the profile list', () => {
  it('carries the masked accounts and nothing else about them', async () => {
    const list = (await api('GET', ''))!.body as { profiles: BrowserProfile[] }
    expect(list.profiles[0].accounts).toEqual([ACCOUNT])
    expect(JSON.stringify(list)).not.toContain('test.person')
  })
  it('omits the field when nothing is known (new profile) or the switch is off', async () => {
    known = []
    const list = (await api('GET', ''))!.body as { profiles: BrowserProfile[] }
    expect(list.profiles[0]).not.toHaveProperty('accounts')
  })
})

describe('POST /:id/accounts/refresh', () => {
  it('Refresh skips the TTL; the popover flag keeps it', async () => {
    expect(await api('POST', '/w1/accounts/refresh')).toEqual({ status: 200, body: { accounts: [ACCOUNT] } })
    await api('POST', '/w1/accounts/refresh', 'popover=1')
    expect(asked).toEqual([{ id: 'w1', respectTtl: false }, { id: 'w1', respectTtl: true }])
  })
  it('404 for an unknown profile, 404 for another verb or path', async () => {
    expect(await api('POST', '/bp-missing/accounts/refresh')).toMatchObject({ status: 404, body: { error: 'profile_not_found' } })
    expect(await api('GET', '/w1/accounts/refresh')).toMatchObject({ status: 404 })
    expect(await api('POST', '/w1/accounts/other')).toMatchObject({ status: 404 })
  })
  it('without an account service the answer is an empty list, not an error', async () => {
    d = { ...d, profiles: { profiles: rig.svc, ops: rig.ops } }
    expect(await api('POST', '/w1/accounts/refresh')).toEqual({ status: 200, body: { accounts: [] } })
  })
})

describe('deleting a profile', () => {
  it('tells the owner of the account cache', async () => {
    const gone: string[] = []
    rig.ops.onRemoved = (id) => { gone.push(id) }
    const made = rig.svc.create({ name: 'Temp' })
    if (!made.ok) throw new Error('profile not created')
    expect(removeProfile(rig.ops, made.value.id).ok).toBe(true)
    expect(gone).toEqual([made.value.id])
  })
})
