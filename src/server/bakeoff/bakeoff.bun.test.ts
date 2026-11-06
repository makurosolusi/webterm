// Bake-off end to end on a throwaway git repo: real worktrees, the real `agent.spawn` spawner and
// process runner with a fake agent script in place of `claude` (no model is ever called), the real
// F4-c verifier, a real ledger (in-memory, migrated to v20) and the inbox card.
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startExec, type ExecSpec } from '../central/agents/execRunner'
import { setCostCap } from '../cost/costOracle'
import { getInboxItem } from '../inbox/inboxItemStore'
import { LATEST_VERSION, migrate } from '../ledger/migration'
import { MIGRATIONS } from '../ledger/ledgerSchema'
import { applyV20 } from '../ledger/ledgerSchemaV20'
import { createAgentSpawner } from '../spawn/agentSpawn'
import { verifyWorktreeCompletion } from '../verifier/verifier.checks'
import { handleBakeoffApi } from './bakeoff.api'
import { createBakeoffService, type BakeoffService } from './bakeoff.service'
import { createBakeoffStore } from './bakeoff.store'

const T = 60_000 // real git + npm test per candidate
let tmp: string
let repo: string
let root: string
let db: Database
let argvSeen: string[][]
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code)

// Candidate n (from its worktree dir `...-<n>`) writes answer.txt plus a secret-looking .env, and
// prints Claude Code's final JSON result with cost 0.n5 USD; candidate 3 fails.
const FAKE_AGENT = `n=$(basename "$PWD" | sed 's/.*-//')
[ "$n" = 3 ] && { echo '{"type":"result","is_error":true,"subtype":"error_max_turns"}'; exit 1; }
echo "candidate $n" > answer.txt
echo "TOKEN=x" > .env
printf '{"type":"result","is_error":false,"result":"done","total_cost_usd":0.%s5,"duration_ms":7}\\n' "$n"`

function service(): BakeoffService {
  const spawner = createAgentSpawner({
    record: () => {}, registerSpawn: () => {}, ancestors: () => [], onPtyExit: () => {},
    exec: (spec: ExecSpec) => { argvSeen.push([...spec.argv]); return startExec({ ...spec, argv: ['sh', '-c', FAKE_AGENT] }) },
  })
  return createBakeoffService({ ctx: { db, now: Date.now }, spawn: (r) => spawner.spawn(r), verify: verifyWorktreeCompletion, worktree: { root } })
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'bko-')))
  repo = join(tmp, 'proj')
  root = join(tmp, 'worktrees')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'user.email', 't@t')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', private: true, scripts: { test: 'node -e 0' } }))
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  db = new Database(':memory:')
  migrate(db)
  argvSeen = []
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

test('fans one prompt out to N worktrees and fills a comparison card per candidate', async () => {
  const svc = service()
  const b = await svc.start({ repo, prompt: 'Write answer.txt', count: 2, workspaceId: 'ws1' })
  expect(b.status).toBe('running')
  expect(b.candidates.map((c) => c.branch)).toEqual([`bakeoff-${b.id.slice(0, 6)}-1`, `bakeoff-${b.id.slice(0, 6)}-2`])
  // Headless Claude Code print mode with the scoped tool list, never the real binary in this test.
  expect(argvSeen.map((a) => a.slice(0, 2))).toEqual([['claude', '-p'], ['claude', '-p']])
  expect(argvSeen[0]).toContain('--allowedTools')
  await svc.settled(b.id)
  const done = svc.get(b.id)
  expect(done.status).toBe('ready')
  expect(done.candidates.map((c) => c.costMicros)).toEqual([150_000, 250_000])
  // Each candidate is a cost run, so it counts toward the cost caps.
  expect(db.query("SELECT ref, node_id, cost_micros FROM cost_run WHERE kind = 'bakeoff' ORDER BY cost_micros").all())
    .toEqual(done.candidates.map((c) => ({ ref: b.id, node_id: c.nodeId, cost_micros: c.costMicros })))
  for (const c of done.candidates) {
    expect(c.status).toBe('done')
    expect(c.verified).toBe(true)
    expect(c.verdict?.diffStat).toContain('answer.txt | 1 +')
    // The untracked .env still counts as changed for the verifier, but was never committed.
    expect(c.verdict?.files).toEqual(['.env', 'answer.txt'])
    expect(c.verdict?.tests).toEqual({ passed: 1, failed: 0 })
    expect(readFileSync(join(c.path, 'answer.txt'), 'utf8')).toBe(`candidate ${c.idx}\n`)
  }
  const item = getInboxItem(db, done.inboxItemId!)
  expect(item).toMatchObject({ kind: 'review', source: 'bakeoff', status: 'open', workspaceId: 'ws1' })
  expect(item?.body).toContain('#2')
  expect(item?.body).toContain('$0.25')
}, T)

test('a failed agent is a failed card; the others still make the bake-off ready', async () => {
  const svc = service()
  const b = await svc.start({ repo, prompt: 'x', count: 3 })
  await svc.settled(b.id)
  const c3 = svc.get(b.id).candidates[2]!
  expect(c3.status).toBe('failed')
  expect(c3.error).toBe('agent reported an error (error_max_turns)')
  expect(svc.get(b.id).status).toBe('ready')
}, T)

test('each candidate is committed without secrets; pick, merge lands it, cleanup only after confirm', async () => {
  const svc = service()
  const b = await svc.start({ repo, prompt: 'x', count: 2 })
  await svc.settled(b.id)
  const [loser, winner] = svc.get(b.id).candidates as [typeof b.candidates[0], typeof b.candidates[0]]
  expect(await codeOf(svc.merge(b.id))).toBe('wrong_state') // no winner yet
  const picked = await svc.pick(b.id, winner.id)
  expect(picked).toMatchObject({ status: 'picked', winnerId: winner.id })
  expect(getInboxItem(db, picked.inboxItemId!)).toMatchObject({ status: 'done', resolution: 'winner #2' })
  expect(git(winner.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('answer.txt')
  expect(git(winner.path, 'status', '--porcelain')).toBe('?? .env')

  // Cleanup without confirm touches nothing and lists only the loser (winner is not merged yet).
  const ask = await svc.cleanup(b.id, false)
  expect(ask.needsConfirm && ask.remove.map((c) => c.id)).toEqual([loser.id])
  expect(existsSync(loser.path)).toBe(true)

  writeFileSync(join(repo, 'package.json'), '{}')
  expect(await codeOf(svc.merge(b.id))).toBe('dirty_repo')
  git(repo, 'checkout', '--', 'package.json')
  const merged = await svc.merge(b.id)
  expect(merged.status).toBe('merged')
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8')).toBe('candidate 2\n')
  expect(existsSync(join(repo, '.env'))).toBe(false)

  const r = await svc.cleanup(b.id, true)
  expect(r.needsConfirm === false && r.removed).toEqual([loser.id, winner.id])
  expect(existsSync(loser.path) || existsSync(winner.path)).toBe(false)
  expect(git(repo, 'branch', '--list', 'bakeoff-*')).toBe('')
  expect(svc.get(b.id).status).toBe('cleaned')
}, T)

test('rejects a bad count and leaves no worktrees behind', async () => {
  const svc = service()
  expect(await codeOf(svc.start({ repo, prompt: 'x', count: 5 }))).toBe('bad_request')
  expect(await codeOf(svc.start({ repo, prompt: '  ', count: 2 }))).toBe('bad_request')
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
}, T)

test('the daily cost cap refuses a bake-off whose N x estimate does not fit, before any worktree exists', async () => {
  const svc = service()
  const first = await svc.start({ repo, prompt: 'x', count: 2 }) // records 150k + 250k, median 200k per candidate
  await svc.settled(first.id)
  setCostCap(db, 'day', 1_000_000) // 600k left
  const worktrees = git(repo, 'worktree', 'list')
  const spawned = argvSeen.length
  const refused = svc.start({ repo, prompt: 'x', count: 4 })
  expect(await codeOf(refused)).toBe('cost_cap')
  const message = 'A bake-off of 4 candidates is estimated at $0.80, but only $0.60 of the $1.00 daily cost cap remains. Use fewer candidates or raise the cap.'
  expect(await refused.catch((e: Error) => e.message)).toBe(message)
  const ui = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, origin: 'http://127.0.0.1:8700', host: '127.0.0.1:8700' }
  const viaApi = await handleBakeoffApi({ service: svc, isNodeToken: () => false }, { method: 'POST', headers: ui } as unknown as IncomingMessage,
    new URL('http://127.0.0.1:8700/api/bakeoff'), async () => JSON.stringify({ repo, prompt: 'x', count: 4 }))
  expect(viaApi).toEqual({ status: 429, body: { error: 'cost_cap', message } })
  expect(git(repo, 'worktree', 'list')).toBe(worktrees)
  expect(argvSeen).toHaveLength(spawned)
  expect(svc.list()).toHaveLength(1)
  const ok = await svc.start({ repo, prompt: 'x', count: 3 }) // 600k fits exactly
  await svc.settled(ok.id)
  expect(svc.get(ok.id).candidates).toHaveLength(3)
}, T)

test('recover fails candidates orphaned by a restart and opens the card', () => {
  const store = createBakeoffStore({ db, now: Date.now })
  store.insert({ id: 'b1', workspaceId: null, repo, baseBranch: 'main', baseSha: 'abc', prompt: 'x' })
  store.insertCandidate({ id: 'b1-1', bakeoffId: 'b1', idx: 1, nodeId: 'n', path: '/nope', branch: 'b' })
  const svc = service()
  svc.recover()
  const b = svc.get('b1')
  expect(b.status).toBe('ready')
  expect(b.candidates[0]).toMatchObject({ status: 'failed', error: 'server restarted before the agent finished' })
})

test('api: agent credentials get 403, reads are open, cleanup asks for confirm with 409', async () => {
  const svc = service()
  const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers }) as unknown as IncomingMessage
  const u = (p: string) => new URL(`http://127.0.0.1:8700${p}`)
  const ui = { 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE, origin: 'http://127.0.0.1:8700', host: '127.0.0.1:8700' }
  const body = (v: unknown) => async () => JSON.stringify(v)
  const agent = await handleBakeoffApi({ service: svc, isNodeToken: () => true }, req('POST', { 'x-webterm-token': 'tok' }), u('/api/bakeoff'), body({ repo, prompt: 'x', count: 2 }))
  expect(agent?.status).toBe(403)
  expect(argvSeen).toHaveLength(0)
  const deps = { service: svc, isNodeToken: () => false }
  expect((await handleBakeoffApi(deps, req('POST', ui), u('/api/bakeoff'), body({ repo: 'rel', prompt: 'x', count: 2 })))?.status).toBe(400)
  const started = await handleBakeoffApi(deps, req('POST', ui), u('/api/bakeoff'), body({ repo, prompt: 'x', count: 2 }))
  expect(started?.status).toBe(201)
  const id = (started?.body as { id: string }).id
  await svc.settled(id)
  expect((await handleBakeoffApi(deps, req('GET'), u('/api/bakeoff'), body({})))?.body).toMatchObject({ bakeoffs: [{ id, status: 'ready' }] })
  expect((await handleBakeoffApi(deps, req('GET'), u('/api/bakeoff/missing'), body({})))?.status).toBe(404)
  const winner = svc.get(id).candidates[0]!
  expect((await handleBakeoffApi(deps, req('POST', ui), u(`/api/bakeoff/${id}/pick`), body({ candidateId: winner.id })))?.status).toBe(200)
  const ask = await handleBakeoffApi(deps, req('POST', ui), u(`/api/bakeoff/${id}/cleanup`), body({}))
  expect(ask?.status).toBe(409)
  expect(ask?.body).toMatchObject({ error: 'needs_confirm' })
  expect(await handleBakeoffApi(deps, req('GET'), u('/api/other'), body({}))).toBeNull()
}, T)

test('v19 -> v20 adds the bake-off tables; a re-run keeps rows', () => {
  const fresh = new Database(':memory:')
  expect(migrate(fresh, MIGRATIONS.filter((m) => m.version <= 19))).toBe(19)
  expect(migrate(fresh)).toBe(LATEST_VERSION)
  createBakeoffStore({ db: fresh, now: Date.now }).insert({ id: 'b', workspaceId: null, repo: '/r', baseBranch: 'main', baseSha: 's', prompt: 'p' })
  applyV20(fresh)
  expect(fresh.query('SELECT COUNT(*) AS n FROM bakeoff').get()).toEqual({ n: 1 })

})
