// What an agent learns about signed-in accounts: provider, state, name and MASKED email, through `webterm browser profiles`
// and Central's profile view. Never a cookie, an avatar, a time or a full address.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserState } from '../../shared/browser.contract'
import type { ProfileAccount } from '../../shared/browser.accounts'
import { AGENT_NAME_MAX } from '../../shared/browser.accounts'
import type { Workspace } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import { profileView } from '../central/tools/defs/browser.profile'
import { handleBrowserControl, type BrowserControlDeps } from './browserControl.handler'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { makeRig, ws, type Rig } from './browser.profiles.testkit'

// test-only values
const GOOGLE: ProfileAccount = { provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com', avatarUrl: 'https://lh3.googleusercontent.com/a/x', checkedAt: 9 }
const GITHUB: ProfileAccount = { provider: 'github', state: 'signed_out', checkedAt: 9 }
let board: Workspace
let rig: Rig
beforeEach(() => {
  board = ws('w1', 'Alpha', [{ id: 'a1', kind: 'agent', x: 0, y: 0 }])
  rig = makeRig([board])
  rig.svc.create({ name: 'work' })
  rig.svc.deps.accounts = (id) => (id === 'w1' ? [GOOGLE, GITHUB] : [])
})
afterEach(() => forgetNodeToken('a1'))

const state = (id: string): BrowserState => ({ id, url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
const deps = (): BrowserControlDeps => ({
  capabilities: { verify: () => undefined, allows: () => false }, verbs: {} as AgentVerbs, agentAllowed: () => true, policy: () => null,
  linked: (who, wanted) => resolveLinkedBrowser([board], who, wanted),
  open: { canvas: async () => ({ add: () => ({ ok: true, updatedAt: 1, nodes: [] }), workspaceOfNode: () => board }), start: async (id) => state(id), newId: () => 'nb1', profiles: { resolve: (r, w) => rig.svc.resolve(r, w), list: (w) => rig.svc.list(w) } },
})

describe('webterm browser profiles', () => {
  it('lists accounts as provider, state, name and masked email only', async () => {
    const r = await handleBrowserControl({ method: 'GET', path: '/api/control/browser/profiles', headers: { [TOKEN_HEADER]: nodeToken('a1') }, body: undefined }, deps())
    const list = (r as { body: { data: { profiles: Array<{ name: string; accounts?: unknown[] }> } } }).body.data.profiles
    expect(list.find((p) => p.name === 'Default (Alpha)')?.accounts).toEqual([
      { provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com' },
      { provider: 'github', state: 'signed_out' },
    ])
    expect(list.find((p) => p.name === 'work')).not.toHaveProperty('accounts')
    expect(JSON.stringify(r)).not.toMatch(/avatar|googleusercontent|checkedAt/)
  })
})

describe('Central profile view', () => {
  it('carries the same safe account view and clips a long third-party name', () => {
    const p = rig.svc.list().find((x) => x.id === 'w1')!
    expect(profileView(p).accounts?.[0]).toEqual({ provider: 'google', state: 'signed_in', displayName: 'Test Person', emailMasked: 't***@gmail.com' })
    const long = { ...p, accounts: [{ ...GOOGLE, displayName: 'x'.repeat(80) }] }
    expect(profileView(long).accounts?.[0].displayName).toHaveLength(AGENT_NAME_MAX)
    expect(profileView(rig.svc.list().find((x) => x.name === 'work')!)).not.toHaveProperty('accounts')
  })
})
