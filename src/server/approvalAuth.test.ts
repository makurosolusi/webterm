// UI-origin approval, agent-credential deny: the pure policy, then the real path an HTTP request
// takes (outer `authorizeRequest` gate as in index.ts, then `approvalHumanRoute`) over a real ledger.
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_CANNOT_APPROVE, APPROVAL_BROWSER_ONLY, uiOnlyDenial } from './approvalAuth'
import { approvalHumanRoute } from './approvalHumanApi'
import { LOOPBACK_ACTOR, ROOT_ACTOR } from './approvalHumanShared'
import { authorizeRequest } from './auth'
import { setTokenState } from './tokenBootstrap'
import { forgetNodeToken, isValidNodeToken, nodeToken } from './hooksTokens'
import { memoryLedgerRuntime, seedProject } from './approvalTestRuntime.testutil'
import { TEST_UI_COOKIE } from './uiSession.testutil'

const HOST = '127.0.0.1:8700'
const BROWSER = { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE }
const ROOT = 'r'.repeat(40) // test-only
const NODE_ID = 'node-approval-auth-test'

afterEach(() => {
  forgetNodeToken(NODE_ID)
  setTokenState({ token: undefined, source: 'none', created: false })
})

const reqOf = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage
const deny = (headers: Record<string, string>, path = '/api/approvals') =>
  uiOnlyDenial(reqOf(headers), new URL(path, 'http://x'), isValidNodeToken)

describe('uiOnlyDenial', () => {
  it('admits the webterm page and refuses non-browser or foreign callers', () => {
    expect(deny(BROWSER)).toBeNull()
    expect(deny({ host: HOST, 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE })).toBeNull() // same-origin GET omits Origin
    expect(deny({ ...BROWSER, cookie: '' })).toBe(APPROVAL_BROWSER_ONLY) // forged fetch metadata, no session
    expect(deny({ ...BROWSER, cookie: 'wt_ui=' + 'x'.repeat(43) })).toBe(APPROVAL_BROWSER_ONLY) // dead session
    expect(deny({ host: HOST })).toBe(APPROVAL_BROWSER_ONLY) // curl
    expect(deny({ ...BROWSER, 'sec-fetch-site': 'cross-site' })).toBe(APPROVAL_BROWSER_ONLY)
    expect(deny({ ...BROWSER, 'sec-fetch-site': 'same-site' })).toBe(APPROVAL_BROWSER_ONLY)
    expect(deny({ ...BROWSER, origin: 'http://evil.test' })).toBe(APPROVAL_BROWSER_ONLY)
    expect(deny({ ...BROWSER, origin: 'null' })).toBe(APPROVAL_BROWSER_ONLY)
  })

  it('refuses agent credentials even with correct fetch metadata', () => {
    const agent = nodeToken(NODE_ID)
    expect(deny({ ...BROWSER, 'x-webterm-token': agent })).toBe(AGENT_CANNOT_APPROVE)
    expect(deny(BROWSER, `/api/approvals?token=${agent}`)).toBeNull() // the query is never read as a credential
    expect(deny({ ...BROWSER, 'x-webterm-capability': 'wcap_anything' })).toBe(AGENT_CANNOT_APPROVE)
    expect(deny({ ...BROWSER, 'x-webterm-token': ROOT })).toBeNull() // root token is not a node token
  })
})

/** One request through the same two gates index.ts + api.ts apply. */
async function serve(
  path: string,
  headers: Record<string, string>,
  rootToken: string | undefined,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const url = new URL(path, 'http://x')
  const outer = authorizeRequest({
    headers,
    expectedToken: rootToken,
    isUiSession: (raw) => raw === TEST_UI_COOKIE.split('=')[1],
    pathname: url.pathname,
    isNodeToken: isValidNodeToken,
    isCapabilityToken: () => false,
  })
  if (!outer) return { status: 403, json: { error: 'forbidden' } } // refuseRequest (bootWiring.ts)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = body === undefined ? 'GET' : 'POST'
  req.headers = headers
  let status = 200
  let payload = ''
  const res = { set statusCode(v: number) { status = v }, setHeader() {}, end(d = '') { payload = d } }
  await approvalHumanRoute(req, res as unknown as ServerResponse, url, { runtime, now: () => clock.at })
  return { status, json: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) }
}

let { runtime, clock } = memoryLedgerRuntime()

/** request -> challenge -> decide; returns the decide response and the recorded approver. */
async function approveFlow(headers: Record<string, string>, rootToken?: string) {
  ;({ runtime, clock } = memoryLedgerRuntime())
  seedProject(runtime)
  const created = await serve('/api/approvals/request', headers, rootToken, {
    requestId: 'req-00000101', projectId: 'p1', kind: 'deploy', request: { a: 1 },
  })
  const id = String(created.json['id'])
  const view = await serve(`/api/approvals/challenge?id=${id}`, headers, rootToken)
  const decided = await serve('/api/approvals/decide', headers, rootToken, {
    requestId: 'req-00000102', id, digest: view.json['digest'], nonce: view.json['nonce'], approve: true,
  })
  return { created, decided, approvedBy: runtime.ledger.approval.getApproval(id)?.approvedBy }
}

describe('approval over the full gate stack', () => {
  it('the signed-in webterm page approves as human:loopback with no env', async () => {
    const { decided, approvedBy } = await approveFlow(BROWSER)
    expect(decided.status).toBe(200)
    expect(approvedBy).toBe(LOOPBACK_ACTOR)
  })

  it('curl, cross-site and foreign Origin are refused before any row exists', async () => {
    expect((await approveFlow({ host: HOST })).created).toEqual({ status: 403, json: { error: 'forbidden' } }) // no credential at all
    const forged = await approveFlow({ ...BROWSER, cookie: '' }, ROOT)
    expect(forged.created).toEqual({ status: 403, json: { error: 'forbidden' } })
    const cross = await approveFlow({ host: HOST, 'sec-fetch-site': 'cross-site' })
    expect(cross.created.status).toBe(403)
    const foreign = await approveFlow({ ...BROWSER, origin: 'http://evil.test' })
    expect(foreign.created.status).toBe(403) // outer sameOrigin already refuses a foreign Origin
  })

  it('agent node token or capability header: 403 agent_cannot_approve', async () => {
    const agent = nodeToken(NODE_ID)
    const node = await approveFlow({ ...BROWSER, 'x-webterm-token': agent })
    expect(node.created).toEqual({ status: 403, json: { error: AGENT_CANNOT_APPROVE } })
    const cap = await approveFlow({ ...BROWSER, 'x-webterm-capability': 'wcap_x' })
    expect(cap.created).toEqual({ status: 403, json: { error: AGENT_CANNOT_APPROVE } })
  })

  it('root token enabled: right token approves as human:root, wrong token is refused', async () => {
    setTokenState({ token: ROOT, source: 'file', created: false })
    const ok = await approveFlow({ ...BROWSER, 'x-webterm-token': ROOT }, ROOT)
    expect(ok.decided.status).toBe(200)
    expect(ok.approvedBy).toBe(ROOT_ACTOR)
    const wrong = await approveFlow({ ...BROWSER, cookie: '', 'x-webterm-token': 'x'.repeat(40) }, ROOT)
    expect(wrong.created).toEqual({ status: 403, json: { error: 'forbidden' } })
    // A stray header beside a live cookie is the UI, not the root actor.
    const stray = await approveFlow({ ...BROWSER, 'x-webterm-token': 'x'.repeat(40) }, ROOT)
    expect(stray.approvedBy).toBe(LOOPBACK_ACTOR)
  })
})
