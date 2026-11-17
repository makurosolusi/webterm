import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserVerb } from '../../shared/browser.contract'
import { allows } from '../control/capabilities'
import type { CapabilityRecord } from '../control/capabilities'
import type { ControlRequest } from '../control/controlTypes'
import { handleBrowserControl } from './browserControl.handler'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { BrowserError } from './browserHost.targets'
import { CdpTimeoutError } from './cdp.client'
import { TOKEN_HEADER } from '../auth'
import { forgetNodeToken, nodeToken } from '../hooksTokens'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import type { Workspace } from '../../shared/workspace'

const rec = (verb: string, resource: string): CapabilityRecord =>
  ({ id: 'i', verb: verb as CapabilityRecord['verb'], resource, expiresAt: Number.MAX_SAFE_INTEGER })
// token -> record; `allows` adalah fungsi nyata
const TOKENS: Record<string, CapabilityRecord> = {
  read1: rec('browser.read', 'node:n1'),
  act1: rec('browser.act', 'node:n1'),
  actOther: rec('browser.act', 'node:n2'),
}
const capabilities = { verify: (t: string) => TOKENS[t], allows: (r: CapabilityRecord, v: CapabilityRecord['verb'], res: string) => allows(r, v, res) }

function setup(over: Partial<Record<BrowserVerb, (id: string, b: unknown) => Promise<unknown>>> = {}, agentAllowed = true) {
  const verbs = new Proxy({} as AgentVerbs, {
    get: (_t, verb: string) => over[verb as BrowserVerb] ?? (async () => ({ ok: true })),
  })
  return (req: Partial<ControlRequest> & { path: string }, token?: string) =>
    handleBrowserControl(
      { method: 'POST', headers: token ? { 'x-webterm-capability': token } : {}, ...req },
      { capabilities, verbs, agentAllowed: () => agentAllowed },
    )
}
const P = (verb: string, node = 'n1') => ({ path: `/api/control/browser/${node}/${verb}` })

describe('handleBrowserControl routing', () => {
  it('returns null for paths outside the browser prefix', async () => {
    expect(await setup()({ path: '/api/control/nodes/n1' }, 'act1')).toBeNull()
  })
  it('404 for unknown verb / bad shape (incl. prototype keys), 400 for unsafe node id, 405 for wrong method', async () => {
    const h = setup()
    expect((await h(P('nope'), 'act1'))?.status).toBe(404)
    expect((await h(P('constructor'), 'act1'))?.status).toBe(404)
    expect((await h({ path: '/api/control/browser/n1' }, 'act1'))?.status).toBe(404)
    expect((await h({ path: '/api/control/browser/status' }, 'read1'))?.status).toBe(400) // capability: node wajib di path
    expect((await h({ path: '/api/control/browser/n1/click/x' }, 'act1'))?.status).toBe(404)
    expect((await h(P('click', 'a b;x'), 'act1'))?.status).toBe(400)
    expect((await h({ ...P('click'), method: 'GET' }, 'act1'))?.status).toBe(405)
  })
})

describe('handleBrowserControl auth', () => {
  it('401 without or with an unknown capability', async () => {
    const h = setup()
    expect((await h(P('status')))?.status).toBe(401)
    expect((await h(P('status'), 'bogus'))?.status).toBe(401)
  })
  it('403 when the token verb or node does not match the verb', async () => {
    const h = setup()
    expect((await h(P('click'), 'read1'))?.status).toBe(403)
    expect((await h(P('status'), 'act1'))?.status).toBe(403)
    expect((await h(P('click'), 'actOther'))?.status).toBe(403)
  })
  it('403 disabled when agentControl is off, except release', async () => {
    const h = setup({}, false)
    expect(await h(P('click'), 'act1')).toMatchObject({ status: 403, body: { error: 'disabled' } })
    expect((await h(P('release'), 'act1'))?.status).toBe(200)
  })
})

describe('handleBrowserControl success and errors', () => {
  it('wraps data with provenance untrusted-web; status also works over GET', async () => {
    const h = setup({ status: async () => ({ id: 'n1' }) })
    expect(await h({ ...P('status'), method: 'GET' }, 'read1')).toEqual({
      status: 200, body: { ok: true, data: { id: 'n1' }, provenance: 'untrusted-web' },
    })
  })
  it('passes the parsed body to the verb and treats a non-object body as {}', async () => {
    const click = vi.fn(async () => ({ ok: true }))
    const h = setup({ click })
    await h({ ...P('click'), body: { ref: 'e1' } }, 'act1')
    await h({ ...P('click'), body: [1] }, 'act1')
    expect(click.mock.calls).toEqual([['n1', { ref: 'e1' }], ['n1', {}]])
  })
  it.each([
    ['stale_ref', 409], ['not_found', 404], ['too_large', 413], ['bad_request', 400], ['blocked', 403], ['crashed', 502],
  ] as const)('maps BrowserError %s to %i', async (code, status) => {
    const h = setup({ click: async () => { throw new BrowserError(code, 'x https://secret.test/path') } })
    const r = await h(P('click'), 'act1')
    expect(r).toEqual({ status, body: { error: code } })
  })
  it('human_active is 409 with a fixed retry message for the agent, never the internal one', async () => {
    const h = setup({ click: async () => { throw new BrowserError('human_active', 'x https://secret.test/path') } })
    const r = await h(P('click'), 'act1')
    expect(r?.status).toBe(409)
    expect(r?.body).toMatchObject({ error: 'human_active', message: expect.stringMatching(/using this browser right now.*Retry shortly/) })
    expect(JSON.stringify(r?.body)).not.toContain('secret.test')
  })
  it('maps BlockedError to 403 with reason, and unknown errors to a generic 500 without leaking the message', async () => {
    expect(await setup({ navigate: async () => { throw new BlockedError('private_host', 'intranet') } })(P('navigate'), 'act1'))
      .toEqual({ status: 403, body: { error: 'blocked', reason: 'private_host', hostname: 'intranet' } })
    const r = await setup({ navigate: async () => { throw new Error('token=abc123 boom') } })(P('navigate'), 'act1')
    expect(r).toEqual({ status: 500, body: { error: 'internal' } })
  })
  it('a stalled CDP command is a typed 504 timeout (retry hint), not internal', async () => {
    const r = await setup({ navigate: async () => { throw new CdpTimeoutError('cdp Page.navigate (#12) timed out after 15000 ms', 'Page.navigate') } })(P('navigate'), 'act1')
    expect(r).toMatchObject({ status: 504, body: { error: 'timeout', message: expect.stringMatching(/Retry once/) } })
    expect(JSON.stringify(r?.body)).not.toContain('Page.navigate')
  })
})

describe('handleBrowserControl node-token path (target from canvas cables, read live)', () => {
  const board: Workspace = {
    id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: 0, bridges: [],
    nodes: [{ id: 'a1', kind: 'agent', x: 0, y: 0 }, { id: 'a2', kind: 'agent', x: 0, y: 0 }, { id: 'b1', kind: 'browser', x: 0, y: 0 }],
  }
  const wire = () => { board.bridges = [{ id: 'l', source: 'a1', target: 'b1', kind: 'context' }] }
  afterEach(() => { forgetNodeToken('a1'); forgetNodeToken('a2'); board.bridges = [] })
  const run = (who: string, path: string, allowed = true, linked = true) => {
    const verbs = new Proxy({} as AgentVerbs, { get: () => async (id: string) => ({ id }) })
    return handleBrowserControl(
      { method: 'GET', path, headers: { [TOKEN_HEADER]: nodeToken(who) } },
      { capabilities, verbs, agentAllowed: () => allowed, ...(linked ? { linked: (r: string, w?: string) => resolveLinkedBrowser([board], r, w) } : {}) },
    )
  }

  it('wired after the session started: the next call succeeds; unwired again: denied', async () => {
    expect(await run('a1', '/api/control/browser/status')).toMatchObject({ status: 404, body: { error: 'no_linked_browser' } })
    wire()
    expect(await run('a1', '/api/control/browser/status')).toMatchObject({ status: 200, body: { data: { id: 'b1' } } })
    expect(await run('a1', '/api/control/browser/b1/status')).toMatchObject({ status: 200 })
    board.bridges = []
    expect(await run('a1', '/api/control/browser/b1/status')).toMatchObject({ status: 403, body: { error: 'not_linked' } })
  })

  it('an agent not wired to the browser cannot drive it, even naming it', async () => {
    wire()
    expect(await run('a2', '/api/control/browser/b1/status')).toMatchObject({ status: 403, body: { error: 'not_linked' } })
  })

  it('agent control off = disabled; no linked resolver or no node identity = 401', async () => {
    wire()
    expect(await run('a1', '/api/control/browser/status', false)).toMatchObject({ status: 403, body: { error: 'disabled' } })
    expect((await run('a1', '/api/control/browser/status', true, false))?.status).toBe(401)
    expect((await setup()(P('status')))?.status).toBe(401)
  })
})
