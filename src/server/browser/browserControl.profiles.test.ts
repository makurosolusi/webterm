// The agent-terminal side of browser profiles: `open`/`navigate` carry `profile` to the opener, and `profiles` lists the
// names of the caller's board (read-only, node token only).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserState } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import type { CanvasPush } from '../canvas/canvasPush'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import { handleBrowserControl, type BrowserControlDeps } from './browserControl.handler'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { makeRig, ws, type Rig } from './browser.profiles.testkit'

let board: Workspace
let rig: Rig
const state = (id: string): BrowserState => ({ id, url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })
beforeEach(() => {
  board = ws('w1', 'Alpha', [{ id: 'a1', kind: 'agent', x: 0, y: 0 }])
  rig = makeRig([board])
  rig.svc.create({ name: 'work' })
})
afterEach(() => forgetNodeToken('a1'))

const canvas: Pick<CanvasPush, 'add' | 'workspaceOfNode'> = {
  add(input) { board.nodes.push(...input.nodes); board.bridges.push(...(input.bridges ?? [])); return { ok: true, updatedAt: 1, nodes: input.nodes } },
  workspaceOfNode: (id) => (board.nodes.some((n) => n.id === id) ? board : null),
}
const deps = (): BrowserControlDeps => ({
  capabilities: { verify: () => undefined, allows: () => false }, verbs: {} as AgentVerbs, agentAllowed: () => true, policy: () => null,
  linked: (who, wanted) => resolveLinkedBrowser([board], who, wanted),
  open: { canvas: async () => canvas, start: async (id) => state(id), newId: () => 'nb1', profiles: { resolve: (r, w) => rig.svc.resolve(r, w), list: (w) => rig.svc.list(w) } },
})
const call = (verb: string, body?: unknown, method = 'POST') =>
  handleBrowserControl({ method, path: `/api/control/browser/${verb}`, headers: { [TOKEN_HEADER]: nodeToken('a1') }, body }, deps())

describe('webterm browser open --profile / profiles', () => {
  it('open with `profile` puts the new node on that profile and says so', async () => {
    const work = rig.svc.resolve('WORK', 'w1')!
    const r = await call('open', { profile: 'WORK' })
    expect(r).toMatchObject({ status: 200, body: { data: { nodeId: 'nb1', note: expect.stringContaining('on profile "work"') } } })
    expect(board.nodes.find((n) => n.id === 'nb1')?.profileId).toBe(work.id)
  })

  it('an unknown profile is 404 profile_not_found and the message lists the names; a non-string is a 400', async () => {
    const r = await call('open', { profile: 'nope' })
    expect(r).toMatchObject({ status: 404, body: { error: 'profile_not_found' } })
    expect(JSON.stringify(r)).toMatch(/Available: .*work/)
    expect(await call('open', { profile: 7 })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect(board.nodes.some((n) => n.kind === 'browser')).toBe(false)
  })

  it('`profiles` lists name, color and live of the caller board (no ids, no cookie data)', async () => {
    const r = await call('profiles', undefined, 'GET')
    const profiles = (r as { body: { data: { profiles: Array<Record<string, unknown>> } } }).body.data.profiles
    expect(profiles.map((p) => p.name).sort()).toEqual(['Default (Alpha)', 'work'])
    for (const p of profiles) expect(Object.keys(p).sort()).toEqual(['color', 'live', 'name'])
  })

  it('`profiles` is GET only and needs a node token', async () => {
    expect(await call('profiles', {}, 'POST')).toMatchObject({ status: 405 })
    expect(await handleBrowserControl({ method: 'GET', path: '/api/control/browser/profiles', headers: {}, body: undefined }, deps())).toMatchObject({ status: 401 })
  })
})
