import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import type { CanvasAddInput, CanvasPush } from '../canvas/canvasPush'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { handleBrowserControl } from './browserControl.handler'
import type { BrowserControlDeps } from './browserControl.handler'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import { openAgentBrowser } from './browser.agentOpen'

let board: Workspace
let adds: CanvasAddInput[]
let ids: number
const canvas: Pick<CanvasPush, 'add' | 'workspaceOfNode'> = {
  add(input) {
    adds.push(input)
    board.nodes.push(...input.nodes)
    board.bridges.push(...(input.bridges ?? []))
    return { ok: true, updatedAt: 1, nodes: input.nodes }
  },
  workspaceOfNode: (id) => (board.nodes.some((n) => n.id === id) ? board : null),
}
const state = (id: string): BrowserState => ({ id, url: 'about:blank', title: '', loading: false, canBack: false, canForward: false, lease: 'human', live: 'live' })

let start: ReturnType<typeof vi.fn<(id: string, ws: string) => Promise<BrowserState>>>
let calls: Array<[string, string, unknown]>
const capabilities = { verify: () => undefined, allows: () => false } as unknown as BrowserControlDeps['capabilities']

function deps(over: Partial<BrowserControlDeps> = {}): BrowserControlDeps {
  const verbs = new Proxy({} as AgentVerbs, { get: (_t, verb: string) => async (id: string, body: unknown) => { calls.push([verb, id, body]); return { ok: true } } })
  return {
    capabilities, verbs, agentAllowed: () => true, policy: () => null,
    linked: (who, wanted) => resolveLinkedBrowser([board], who, wanted),
    open: { canvas: async () => canvas, start, newId: () => `nb${++ids}` },
    ...over,
  }
}
const call = (verb: string, body?: unknown, who: string | null = 'a1', d = deps()) =>
  handleBrowserControl({ method: 'POST', path: `/api/control/browser/${verb}`, headers: who ? { [TOKEN_HEADER]: nodeToken(who) } : {}, body }, d)

beforeEach(() => {
  board = { id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, bridges: [], nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }] }
  adds = []; ids = 0; calls = []
  start = vi.fn(async (id: string) => state(id))
})
afterEach(() => forgetNodeToken('a1'))

describe('agent verb open', () => {
  it('adds a browser node beside the caller, cabled to it, starts it, and later verbs reach it with no --node', async () => {
    const r = await call('open')
    expect(adds).toEqual([{
      workspaceId: 'w1', anchorNodeId: 'a1',
      nodes: [{ id: 'nb1', kind: 'browser', x: 0, y: 0, width: 640, height: 400 }],
      bridges: [{ id: 'bridge-a1-nb1', source: 'a1', target: 'nb1', kind: 'context' }],
    }])
    expect(start).toHaveBeenCalledWith('nb1', 'w1')
    expect(r).toMatchObject({ status: 200, body: { ok: true, provenance: 'untrusted-web', data: { nodeId: 'nb1', url: 'about:blank', note: expect.stringContaining('--node nb1') } } })
    expect(calls).toEqual([])
    await call('snapshot')
    expect(calls).toEqual([['snapshot', 'nb1', {}]])
  })

  it('with a url it navigates the new node through the normal navigate verb', async () => {
    const r = await call('open', { url: 'https://example.test/a' })
    expect(calls).toEqual([['navigate', 'nb1', { url: 'https://example.test/a' }]])
    expect(r).toMatchObject({ status: 200, body: { data: { ok: true, nodeId: 'nb1', url: 'https://example.test/a' } } })
  })

  it('navigate with no cabled browser opens one first; with one cabled it just navigates it', async () => {
    expect(await call('navigate', { url: 'https://example.test/' })).toMatchObject({ status: 200, body: { data: { ok: true, nodeId: 'nb1' } } })
    expect(calls).toEqual([['navigate', 'nb1', { url: 'https://example.test/' }]])
    await call('navigate', { url: 'https://example.test/b' })
    expect(adds).toHaveLength(1)
    expect(calls[1]).toEqual(['navigate', 'nb1', { url: 'https://example.test/b' }])
  })

  it('other verbs with no cabled browser fail with a hint to run open, and add nothing', async () => {
    const r = await call('snapshot')
    expect(r).toMatchObject({ status: 404, body: { error: 'no_linked_browser', message: expect.stringContaining('webterm browser open <url>') } })
    expect(adds).toEqual([])
  })

  it('an unverified caller is refused before anything is added; a capability holder cannot open', async () => {
    expect((await call('open', {}, null))?.status).toBe(401)
    expect((await handleBrowserControl({ method: 'POST', path: '/api/control/browser/open', headers: { [TOKEN_HEADER]: 'not-a-token' } }, deps()))?.status).toBe(401)
    const cap = { verify: () => ({ id: 'i', verb: 'browser.act', resource: 'node:a1', expiresAt: Number.MAX_SAFE_INTEGER }), allows: () => true } as unknown as BrowserControlDeps['capabilities']
    expect(await handleBrowserControl({ method: 'POST', path: '/api/control/browser/open', headers: { 'x-webterm-capability': 't' } }, deps({ capabilities: cap })))
      .toMatchObject({ status: 400, body: { error: 'agent_node_only' } })
    expect(adds).toEqual([])
  })

  it('max_live: the node and cable stay on the board and the error says so with its id', async () => {
    start.mockRejectedValueOnce(new BlockedError('max_live'))
    const r = await call('open', { url: 'https://example.test/' })
    expect(r).toMatchObject({ status: 403, body: { error: 'blocked', reason: 'max_live', nodeId: 'nb1', note: expect.stringMatching(/live-browser limit[\s\S]*--node nb1/) } })
    expect(board.nodes.map((n) => n.id)).toEqual(['a1', 'nb1'])
    expect(board.bridges).toHaveLength(1)
    expect(calls).toEqual([])
  })

  it('refuses before adding: bad url, navigate without url, --node on open, agent control off, caller not on a board', async () => {
    expect(await call('open', { url: 'javascript:alert(1)' })).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect((await call('navigate', {}))?.status).toBe(400)
    expect(await call('b9/open')).toMatchObject({ status: 400, body: { error: 'bad_request' } })
    expect(await call('open', {}, 'a1', deps({ agentAllowed: () => false }))).toMatchObject({ status: 403, body: { error: 'disabled' } })
    board.nodes = []
    expect(await call('open')).toMatchObject({ status: 404, body: { error: 'not_on_board' } })
    expect(adds).toEqual([])
    expect(start).not.toHaveBeenCalled()
  })

  it('without the open wiring, navigate keeps the plain no_linked_browser answer and open is 503', async () => {
    const d = deps({ open: undefined })
    expect(await call('navigate', { url: 'https://example.test/' }, 'a1', d)).toMatchObject({ status: 404, body: { error: 'no_linked_browser' } })
    expect(await call('open', {}, 'a1', d)).toMatchObject({ status: 503, body: { error: 'open_unavailable' } })
  })
})

describe('Central pre-assigned browser vs the agent\'s own open (playbook.web_research race)', () => {
  const openFor = () => openAgentBrowser({ canvas: async () => canvas, start, newId: () => 'br-run1' }, 'a1', () => true, 'cabled')
  const browsers = () => board.nodes.filter((n) => n.kind === 'browser').map((n) => n.id)

  it('the agent opens first: Central reuses that node instead of adding br-<runId>', async () => {
    await call('navigate', { url: 'https://example.test/' })
    expect(await openFor()).toMatchObject({ ok: true, nodeId: 'nb1', reused: true })
    expect(browsers()).toEqual(['nb1'])
  })

  it('both at once: one node, and the agent navigates the one Central opened', async () => {
    const [central, agent] = await Promise.all([openFor(), call('open', { url: 'https://example.test/' })])
    expect(central).toMatchObject({ ok: true, nodeId: 'br-run1' })
    expect(agent).toMatchObject({ status: 200, body: { data: { nodeId: 'br-run1' } } })
    expect(browsers()).toEqual(['br-run1'])
    expect(calls).toEqual([['navigate', 'br-run1', { url: 'https://example.test/' }]])
  })

  it('an agent open without one from Central still adds its own node', async () => {
    board.nodes.push({ id: 'h1', kind: 'browser', x: 0, y: 0 })
    board.bridges.push({ id: 'bridge-a1-h1', source: 'a1', target: 'h1', kind: 'context' })
    await call('open')
    expect(browsers()).toEqual(['h1', 'nb1'])
  })
})
