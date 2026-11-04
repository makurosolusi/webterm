// Bun-only: the policy wired into the process — persisted node tokens (header-file model), restart,
// cable grant through the real browser control handler, human deny for browser.act, spawn lineage,
// and the api.ts mount answering 503 without a ledger.
import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Workspace, WsNode } from '../../shared/workspace'
import { TOKEN_HEADER } from '../auth'
import { allows } from '../control/capabilities'
import { harness, spawnBody } from '../control/fakeControlDeps'
import type { AgentVerbs } from '../browser/browserAgent.verbs.ctx'
import { resolveLinkedBrowser } from '../browser/browser.linkedTarget'
import { handleBrowserControl } from '../browser/browserControl.handler'
import { resetEventsRuntimeForTest } from '../events/eventsRuntime'
import { claudeHeadersPath } from '../hooksPaths'
import { writeNodeHeaders } from '../hooksSettings'
import { forgetNodeToken, nodeIdForToken, nodeToken, NODE_TOKEN_HEADER, resetNodeTokenMemoryForTest, stateVerified } from '../hooksTokens'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { resetActiveLedgerRuntimeForTest, setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { openLedgerDb } from '../ledger/migration'
import { DECISION_EVENT } from './policy.decide'
import { policyRoute } from './policy.api'
import { activePolicy, resetActivePolicyForTest } from './policy.runtime'

const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'policy-wiring-'))
const prevDir = process.env.WEBTERM_DATA_DIR
// Header files, webterm data and the event anchor all land in the temp root, never ~/.webterm-server.
process.env.WEBTERM_DATA_DIR = root
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
  rmSync(root, { recursive: true, force: true })
})

const node = (id: string, kind: WsNode['kind']): WsNode => ({ id, kind, x: 0, y: 0 })
const BOARD: Workspace[] = [{
  id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a1', 'agent'), node('b1', 'browser')],
  bridges: [{ id: 'e1', source: 'a1', target: 'b1', kind: 'context' }], updatedAt: 0,
}]
const close = (db: Database): void => (db as unknown as { close(): void }).close()

let open: Database | null = null
/** "Boot": (re)open the ledger file, point the process seams at it, forget every in-memory token. */
function boot(path: string): Database {
  if (open) close(open)
  resetNodeTokenMemoryForTest()
  resetEventsRuntimeForTest()
  open = openLedgerDb(path)
  setActiveLedgerRuntime({ mode: 'on', path, db: open } as unknown as LedgerRuntime)
  resetActivePolicyForTest()
  return open
}
afterEach(() => {
  if (open) close(open)
  open = null
  resetActivePolicyForTest()
  resetEventsRuntimeForTest()
  resetActiveLedgerRuntimeForTest()
  resetNodeTokenMemoryForTest()
})

const calls: string[] = []
const verbs = new Proxy({} as AgentVerbs, { get: (_t, verb: string) => async () => { calls.push(verb); return { ok: true } } })
const drive = (verb: string, token: string) => handleBrowserControl(
  { method: 'POST', path: `/api/control/browser/${verb}`, headers: { [TOKEN_HEADER]: token } },
  { capabilities: { verify: () => undefined, allows }, verbs, agentAllowed: () => true, linked: (who, wanted) => resolveLinkedBrowser(BOARD, who, wanted) },
)
const headerToken = (id: string): string | undefined =>
  readFileSync(claudeHeadersPath(id), 'utf8').split('\n').find((l) => l.startsWith(`${NODE_TOKEN_HEADER}: `))?.slice(NODE_TOKEN_HEADER.length + 2)

test('restart keeps the cable grant and the node token valid; re-adopt rewrites the header with the same token', async () => {
  const path = join(root, 'restart.db')
  boot(path)
  writeNodeHeaders('a1')
  const token = nodeToken('a1')
  expect(headerToken('a1')).toBe(token)
  expect(await drive('click', token)).toMatchObject({ status: 200 })

  const db = boot(path) // restart: in-memory token maps are empty now
  expect(nodeIdForToken(token)).toBe('a1')
  expect(stateVerified('a1', token)).toBe(true)
  resetNodeTokenMemoryForTest()
  writeNodeHeaders('a1') // what Sessions.adoptSupervised does for a re-adopted agent
  expect(headerToken('a1')).toBe(token)
  expect(nodeToken('a1')).toBe(token)
  expect(await drive('click', token)).toMatchObject({ status: 200 })
  expect(calls.filter((c) => c === 'click').length).toBe(2)
  const decisions = (db.query('SELECT payload_json FROM event WHERE hash IS NOT NULL AND kind = ?').all(DECISION_EVENT) as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json))
  expect(decisions.at(-1)).toMatchObject({ capability: 'browser.act', effect: 'allow', ruleId: 'cable:a1->b1' })
})

test('a human deny rule for browser.act refuses the cable-wired agent; reads and release still pass', async () => {
  boot(join(root, 'deny.db'))
  const token = nodeToken('a1')
  activePolicy()!.createGrant('human-ui', { subject: 'node:a1', capability: 'browser.act', effect: 'deny' })
  expect(await drive('click', token)).toMatchObject({ status: 403, body: { error: 'policy_denied' } })
  expect(await drive('snapshot', token)).toMatchObject({ status: 200 })
  expect(await drive('release', token)).toMatchObject({ status: 200 })
})

test('forgetting a node revokes its persisted token across a restart', () => {
  const path = join(root, 'forget.db')
  boot(path)
  const token = nodeToken('a1')
  forgetNodeToken('a1')
  boot(path)
  expect(nodeIdForToken(token)).toBe(undefined)
  expect(nodeToken('a1')).not.toBe(token)
})

test('control spawn records the spawner as parent (K3 lineage)', async () => {
  boot(join(root, 'spawn.db'))
  const h = harness()
  const tok = h.token('node.spawn', 'node:node-a')
  expect(await h.call('POST', 'spawn', spawnBody('req-0001', 'node-a'), { 'x-webterm-capability': tok })).toMatchObject({ status: 201 })
  expect(activePolicy()!.store.ancestors('node:node-a')).toEqual(['central'])
})

test('api.ts mount: 503 ledger_off without a ledger, the grant list for the UI with one', async () => {
  const res = () => {
    const r = { statusCode: 0, body: '', setHeader() {}, end(b?: string) { r.body = b ?? '' } }
    return r
  }
  const ui = { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', 'sec-fetch-site': 'same-origin' }
  const req = { method: 'GET', headers: ui } as unknown as IncomingMessage
  const url = new URL('http://127.0.0.1:8700/api/policy/grants')
  const off = res()
  expect(await policyRoute(req, off as unknown as ServerResponse, url)).toBe(true)
  expect([off.statusCode, JSON.parse(off.body)]).toEqual([503, { error: 'ledger_off' }])
  boot(join(root, 'mount.db'))
  const on = res()
  await policyRoute(req, on as unknown as ServerResponse, url)
  expect(on.statusCode).toBe(200)
  expect((JSON.parse(on.body) as { grants: { id: string }[] }).grants.map((g) => g.id)).toContain('builtin-node')
  expect(await policyRoute(req, res() as unknown as ServerResponse, new URL('http://x/api/other'))).toBe(false)
})
