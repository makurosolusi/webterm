// Bun-only: `/api/tools` over the REAL ledger policy (builtin rules, cable grants, human rules), real
// node tokens in the node's header file, a real git repo behind `git.diff`, the real control router behind
// `node.*`, and the real `webterm` CLI + curl against a real HTTP server (end to end).
import { afterAll, afterEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Workspace, WsNode } from '../../shared/workspace'
import { cliPath, installWebtermCli } from '../cli/cli.launcher'
import { snapshotOf } from '../cli/cli.registry'
import { createSeenStore } from '../cli/cli.seen'
import { allows, CapabilityStore, clampTtl } from '../control/capabilities'
import { harness } from '../control/fakeControlDeps'
import { handleControlHttp } from '../control/mount'
import { resetEventsRuntimeForTest } from '../events/eventsRuntime'
import { gitDiffRoute } from '../gitDiff.route'
import { writeNodeHeaders } from '../hooksSettings'
import { NODE_TOKEN_HEADER, nodeToken, resetNodeTokenMemoryForTest } from '../hooksTokens'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { resetActiveLedgerRuntimeForTest, setActiveLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { openLedgerDb } from '../ledger/migration'
import { activePolicy, resetActivePolicyForTest } from '../policy/policy.runtime'
import { toolsRoute, type ToolsDeps } from './capability.http'
import { createMemoryReceiptLog } from './capability.receipt'

const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tools-http-')))
const prevDir = process.env.WEBTERM_DATA_DIR
process.env.WEBTERM_DATA_DIR = join(root, 'data') // header files, CLI and seen state stay in the temp root
afterAll(() => {
  if (prevDir === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = prevDir
  rmSync(root, { recursive: true, force: true })
})

const node = (id: string, kind: WsNode['kind']): WsNode => ({ id, kind, x: 0, y: 0 })
const BOARD: Workspace[] = [{
  id: 'w1', name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a1', 'agent'), node('a2', 'agent'), node('b1', 'browser')],
  bridges: [{ id: 'e1', source: 'a1', target: 'b1', kind: 'context' }], updatedAt: 0,
}]

let db: Database | null = null
let n = 0
function boot(): void {
  resetNodeTokenMemoryForTest()
  resetEventsRuntimeForTest()
  const path = join(root, `ledger-${n++}.db`)
  db = openLedgerDb(path)
  setActiveLedgerRuntime({ mode: 'on', path, db, ledger: {} } as unknown as LedgerRuntime)
  resetActivePolicyForTest()
}
afterEach(() => {
  if (db) (db as unknown as { close(): void }).close()
  db = null
  resetActivePolicyForTest()
  resetEventsRuntimeForTest()
  resetActiveLedgerRuntimeForTest()
  resetNodeTokenMemoryForTest()
})

// A real git repo with one modified file, for `git.diff`.
const repo = realpathSync(mkdtempSync(join(root, 'repo-')))
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' }
const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo, env: gitEnv })
// Once per file (top-level await): every test shares this repo.
await git('init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
await git('add', '.')
await git('commit', '-qm', 'init')
writeFileSync(join(repo, 'a.txt'), 'two\n')

/** The API router stand-in: the real git diff route, the real control router, and a recording browser route. */
function world() {
  const store = new CapabilityStore()
  const h = harness({ capabilities: { verify: (t) => store.verify(t), allows, mint: (o) => ({ token: store.mint(o), expiresAt: Date.now() + clampTtl(o.ttlMs) }) } })
  h.live.set('n7', { output: 'hi' })
  const seen: { url: string; headers: IncomingMessage['headers'] }[] = []
  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
    if (url.pathname.startsWith('/api/control/browser/')) return send(200, { ok: true, data: { verb: url.pathname.split('/').pop() } })
    const g = await gitDiffRoute(url.pathname, req.method ?? 'GET', url.searchParams, async () => '')
    if (g) return send(g.status, g.body)
    if (await handleControlHttp(req, res, url, async () => '', h.deps)) return
    send(404, { error: 'unknown route' })
  }
  const deps: ToolsDeps = { dispatch, workspaces: () => BOARD, capabilities: store, receipts: createMemoryReceiptLog(), seen: createSeenStore(join(root, `seen-${n++}`)) }
  return { deps, store, seen, h }
}

async function call(deps: ToolsDeps, method: string, path: string, opts: { token?: string; body?: unknown; accept?: string } = {}) {
  const server = createServer((req, res) => {
    void toolsRoute(req, res, new URL(req.url ?? '/', 'http://x'), deps).then((hit) => { if (!hit) { res.statusCode = 404; res.end() } })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method, headers: { ...(opts.token ? { [NODE_TOKEN_HEADER]: opts.token } : {}), ...(opts.accept ? { accept: opts.accept } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    const text = await res.text()
    return { status: res.status, text, body: (() => { try { return JSON.parse(text) } catch { return null } })() }
  } finally {
    server.close()
  }
}

type Ctx = { principal: string; capabilities: { name: string; allowed: boolean; decision: string }[] }
const allowedOf = (ctx: Ctx) => ctx.capabilities.filter((c) => c.allowed).map((c) => c.name)

test('agent-context: allowed flags per principal (human, cabled node, uncabled node, human rule)', async () => {
  boot()
  const { deps } = world()
  const human = (await call(deps, 'GET', '/api/tools')).body as Ctx
  expect(human.principal).toBe('human-ui')
  expect(allowedOf(human)).toEqual(snapshotOf().capabilities.map((c) => c.name))

  const a1 = (await call(deps, 'GET', '/api/tools', { token: nodeToken('a1') })).body as Ctx
  expect(a1.principal).toBe('node:a1')
  expect(allowedOf(a1)).toEqual(['browser.act', 'browser.read', 'secret.list']) // the cable is a live browser.* grant
  expect(allowedOf((await call(deps, 'GET', '/api/tools', { token: nodeToken('a2') })).body as Ctx)).toEqual(['secret.list'])

  activePolicy()!.createGrant('human-ui', { subject: 'node:a2', capability: 'git.diff', effect: 'allow' })
  expect(allowedOf((await call(deps, 'GET', '/api/tools', { token: nodeToken('a2') })).body as Ctx)).toEqual(['git.diff', 'secret.list'])
  const text = await call(deps, 'GET', '/api/tools', { token: nodeToken('a2'), accept: 'text/plain' })
  expect(text.text).toMatch(/^\d+ capabilities \(registry [0-9a-f]{12}, schema v1\) for node:a2\./)
  expect(text.text).toMatch(/git\.diff\s+R0\s+allow/)
})

test('agent-context shows the secret broker decisions: list allow, run ask by default, a broad grant allows', async () => {
  boot()
  const { deps } = world()
  const decisionOf = (ctx: Ctx, name: string) => ctx.capabilities.find((c) => c.name === name)?.decision
  const a2 = (await call(deps, 'GET', '/api/tools', { token: nodeToken('a2') })).body as Ctx
  expect([decisionOf(a2, 'secret.list'), decisionOf(a2, 'secret.run')]).toEqual(['allow', 'ask'])
  const human = (await call(deps, 'GET', '/api/tools')).body as Ctx
  expect(decisionOf(human, 'secret.run')).toBe('allow')

  activePolicy()!.createGrant('human-ui', { subject: 'node:a2', capability: 'secret.run', scope: 'secret:*', effect: 'allow' })
  expect(decisionOf((await call(deps, 'GET', '/api/tools', { token: nodeToken('a2') })).body as Ctx, 'secret.run')).toBe('allow')
  activePolicy()!.createGrant('human-ui', { subject: 'node:a2', capability: 'secret.*', scope: '*', effect: 'deny' })
  const denied = (await call(deps, 'GET', '/api/tools', { token: nodeToken('a2') })).body as Ctx
  expect([decisionOf(denied, 'secret.list'), decisionOf(denied, 'secret.run')]).toEqual(['deny', 'deny'])
})

test('agent-context records no policy.decision events; a real call still does', async () => {
  boot()
  const { deps } = world()
  const decisions = () => (db as Database).query("SELECT COUNT(*) AS n FROM event WHERE kind = 'policy.decision'").get() as { n: number }
  const before = decisions().n
  await call(deps, 'GET', '/api/tools', { token: nodeToken('a1') })
  await call(deps, 'GET', '/api/tools')
  expect(decisions().n).toBe(before)
  await call(deps, 'POST', '/api/tools/git.diff', { token: nodeToken('a2'), body: { root: repo } })
  expect(decisions().n).toBe(before + 1)
})

test('without a ledger agents are denied everything and the human keeps pre-policy access', async () => {
  const { deps } = world()
  resetNodeTokenMemoryForTest()
  expect(allowedOf((await call(deps, 'GET', '/api/tools', { token: nodeToken('a1') })).body as Ctx)).toEqual([])
  expect(allowedOf((await call(deps, 'GET', '/api/tools')).body as Ctx).length).toBe(snapshotOf().capabilities.length)
})

test('round trip: git.diff runs through its real route and answers a receipt with the data', async () => {
  boot()
  const { deps } = world()
  const r = await call(deps, 'POST', '/api/tools/git.diff', { body: { root: repo } })
  expect(r.status).toBe(200)
  expect(r.body.receipt).toMatchObject({ outcome: 'ok', detail: 'ok', next: null, evidence: { status: 200 } })
  expect(r.body.data.files.map((f: { path: string }) => f.path)).toEqual(['a.txt'])
})

test('control verbs run as the caller through a one-shot capability that is revoked afterwards', async () => {
  boot()
  const { deps, store, seen } = world()
  const r = await call(deps, 'POST', '/api/tools/node.read', { body: {} })
  expect(r.status).toBe(200)
  expect(r.body.receipt.outcome).toBe('ok')
  expect((r.body.data as { id: string }[]).map((s) => s.id)).toEqual(['n7'])
  expect(seen.at(-1)?.headers['x-webterm-capability']).toMatch(/^wcap_/)
  expect(store.size()).toBe(0)
})

test('policy deny: an agent without a rule never reaches the handler; a human rule opens exactly that call', async () => {
  boot()
  const { deps, seen, h } = world()
  const token = nodeToken('a2')
  const denied = await call(deps, 'POST', '/api/tools/node.close', { token, body: { requestId: 'req-0001', nodeId: 'n7' } })
  expect(denied.status).toBe(403)
  expect(denied.body.receipt).toMatchObject({ outcome: 'denied', detail: 'policy_denied', evidence: { ruleId: 'builtin-node' } })
  expect(denied.body.receipt.next).toMatch(/do not retry/)
  expect(seen).toEqual([])
  expect(h.closed).toEqual([])

  activePolicy()!.createGrant('human-ui', { subject: 'node:a2', capability: 'node.close', scope: 'node:n7', effect: 'allow' })
  const ok = await call(deps, 'POST', '/api/tools/node.close', { token, body: { requestId: 'req-0001', nodeId: 'n7' } })
  expect(ok.body.receipt).toMatchObject({ outcome: 'ok' })
  expect(h.closed).toEqual(['n7'])
  // The scope still holds: another node is denied.
  expect((await call(deps, 'POST', '/api/tools/node.close', { token, body: { requestId: 'req-0002', nodeId: 'n8' } })).body.receipt.outcome).toBe('denied')
})

test('a cabled agent drives its browser: the target comes from the cable and its own token is forwarded', async () => {
  boot()
  const { deps, seen } = world()
  const token = nodeToken('a1')
  const r = await call(deps, 'POST', '/api/tools/browser.read', { token, body: { verb: 'snapshot' } })
  expect(r.body.receipt.outcome).toBe('ok')
  expect(seen.at(-1)?.url).toBe('/api/control/browser/b1/snapshot')
  expect(seen.at(-1)?.headers[NODE_TOKEN_HEADER]).toBe(token)
  expect(seen.at(-1)?.headers['x-webterm-capability']).toBe(undefined)
  const none = await call(deps, 'POST', '/api/tools/browser.read', { token: nodeToken('a2'), body: { verb: 'snapshot' } })
  expect(none.body.receipt).toMatchObject({ outcome: 'error', detail: 'no_linked_browser' })
})

test('bad input, unknown names and operationId replay', async () => {
  boot()
  const { deps, seen } = world()
  expect((await call(deps, 'POST', '/api/tools/git.diff', { body: {} })).body.receipt).toMatchObject({ outcome: 'error', detail: 'invalid_shape', evidence: { problem: '$.root: required' } })
  expect((await call(deps, 'POST', '/api/tools/nope.nope', { body: {} })).status).toBe(404)
  expect((await call(deps, 'POST', '/api/tools/git.diff', { body: [1] })).body.receipt.detail).toBe('invalid_json')
  expect((await call(deps, 'GET', '/api/tools/git.diff')).status).toBe(405)
  const first = await call(deps, 'POST', '/api/tools/git.diff?operationId=op-1', { body: { root: repo } })
  const again = await call(deps, 'POST', '/api/tools/git.diff?operationId=op-1', { body: { root: repo } })
  expect(first.body.receipt).toMatchObject({ outcome: 'ok', operationId: 'op-1' })
  expect(again.body.receipt).toMatchObject({ outcome: 'ok', operationId: 'op-1', replayed: true })
  expect(seen.length).toBe(1)
  expect((await call(deps, 'POST', '/api/tools/git.diff?operationId=op-1', { body: { root: '/other' } })).body.receipt.detail).toBe('operation_conflict')
})

test('whats-new: everything on first sight, nothing after, and the diff against an older registry', async () => {
  boot()
  const { deps } = world()
  const token = nodeToken('a1')
  const first = (await call(deps, 'GET', '/api/tools/whats-new', { token })).body
  expect(first).toMatchObject({ since: null, baseline: 'none', removed: [], changed: [] })
  expect(first.added).toEqual(snapshotOf().capabilities.map((c) => c.name))
  const second = (await call(deps, 'GET', '/api/tools/whats-new', { token })).body
  expect(second).toMatchObject({ since: first.version, baseline: 'known', added: [], removed: [], changed: [] })

  // An older server: no git.diff, node.read at another tier, and a capability since removed.
  const now = snapshotOf()
  const old = { version: 'aaaaaaaaaaaa', capabilities: [...now.capabilities.filter((c) => c.name !== 'git.diff').map((c) => (c.name === 'node.read' ? { ...c, tier: 'R2' as const } : c)), { ...now.capabilities[0], name: 'old.gone' }] }
  deps.seen!.saveSnapshot(old)
  const diff = (await call(deps, 'GET', '/api/tools/whats-new?since=aaaaaaaaaaaa', { token })).body
  expect(diff).toMatchObject({ since: 'aaaaaaaaaaaa', baseline: 'known', added: ['git.diff'], removed: ['old.gone'], changed: [{ name: 'node.read', fields: ['tier'] }] })
  expect((await call(deps, 'GET', '/api/tools/whats-new?since=bbbbbbbbbbbb', { token })).body.baseline).toBe('unknown')
  expect((await call(deps, 'GET', '/api/tools/whats-new?since=../x', { token })).status).toBe(400)
  // The plain-text form the CLI prints without --json.
  expect((await call(deps, 'GET', '/api/tools/whats-new?since=aaaaaaaaaaaa', { token, accept: 'text/plain' })).text).toContain('+ git.diff')
})

test('end to end: the real CLI, curl and the node header file against a real server', async () => {
  boot()
  const { deps } = world()
  installWebtermCli(join(root, 'home'))
  const hdr = writeNodeHeaders('a1')
  const token = nodeToken('a1')
  activePolicy()!.createGrant('human-ui', { subject: 'node:a1', capability: 'git.diff', effect: 'allow' })
  const server: Server = createServer((req, res) => { void toolsRoute(req, res, new URL(req.url ?? '/', 'http://x'), deps) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = String((server.address() as AddressInfo).port)
  // Async spawn: the server lives on this event loop, so a sync spawn would deadlock.
  const cli = (...args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', WEBTERM_NODE_HEADERS: hdr, NODETERM_PORT: port }
    execFile(cliPath(), args, { env }, (err, out) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out }))
    expect(args.join(' ')).not.toContain(token) // the token is never on the CLI's argv
  })
  try {
    const ctx = await cli('agent-context', '--json')
    expect(ctx.code).toBe(0)
    expect(allowedOf(JSON.parse(ctx.out))).toEqual(['browser.act', 'browser.read', 'git.diff', 'secret.list'])
    const ok = await cli('git.diff', '--json', JSON.stringify({ root: repo }))
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.out).receipt.outcome).toBe('ok')
    const denied = await cli('node.close', '--json', '{"requestId":"req-0009","nodeId":"n7"}')
    expect(denied.code).toBe(1)
    expect(JSON.parse(denied.out).receipt).toMatchObject({ outcome: 'denied', detail: 'policy_denied' })
    expect((await cli('whats-new')).out).toContain('No changes')
  } finally {
    server.close()
  }
  expect(spawnSync('sh', ['-n', cliPath()]).status).toBe(0)
})
