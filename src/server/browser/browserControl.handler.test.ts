import { describe, expect, it, vi } from 'vitest'
import { BlockedError } from '../../shared/browser.contract'
import type { BrowserVerb } from '../../shared/browser.contract'
import { allows } from '../control/capabilities'
import type { CapabilityRecord } from '../control/capabilities'
import type { ControlRequest } from '../control/controlTypes'
import { handleBrowserControl } from './browserControl.handler'
import type { AgentVerbs } from './browserAgent.verbs.ctx'
import { BrowserError } from './browserHost.targets'

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
    ['stale_ref', 409], ['lease_human', 409], ['human_active', 409], ['not_found', 404], ['too_large', 413], ['bad_request', 400], ['blocked', 403], ['crashed', 502],
  ] as const)('maps BrowserError %s to %i', async (code, status) => {
    const h = setup({ click: async () => { throw new BrowserError(code, 'x https://secret.test/path') } })
    const r = await h(P('click'), 'act1')
    expect(r).toEqual({ status, body: { error: code } })
  })
  it('maps BlockedError to 403 with reason, and unknown errors to a generic 500 without leaking the message', async () => {
    expect(await setup({ navigate: async () => { throw new BlockedError('private_host', 'intranet') } })(P('navigate'), 'act1'))
      .toEqual({ status: 403, body: { error: 'blocked', reason: 'private_host', hostname: 'intranet' } })
    const r = await setup({ navigate: async () => { throw new Error('token=abc123 boom') } })(P('navigate'), 'act1')
    expect(r).toEqual({ status: 500, body: { error: 'internal' } })
  })
})
