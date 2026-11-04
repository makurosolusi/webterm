// Bun-only (bun:sqlite, real ledger v16 schema): the DAG scheduler with fake ports (no git, no real
// Claude). Waves from leases, human-only gates (403 for agents) with reblock, the 3-strike breaker,
// the stale-base guard, verifier-only completion with the lease, escalation binding, events.
import { expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { freshDb, T0 } from '../central/guard/controlGuard.testutil'
import type { ExecOutcome } from '../central/agents/execRunner'
import { beginCostRun, costGate, endCostRun, setCostCap, type BeginRunInput } from '../cost/costOracle'
import type { AppendEventInput } from '../events/eventModel'
import { createGate } from '../inbox/inboxItemStore'
import { execWrite } from '../ledger/ledgerCore'
import { LATEST_VERSION } from '../ledger/migration'
import { SERVER_VERIFIED_BY } from '../orchestrator/orchestratorModel'
import type { VerifyOutcome } from '../orchestrator/verify'
import type { AgentSpawnRequest } from '../spawn/agentSpawn'
import { judgeCompletion } from '../verifier/verifier.judge'
import { handleDagApi, type DagApiDeps } from './dag.api'
import { createDagScheduler, dagWorkerArgv, type DagPorts, type VerifyTaskInput } from './dag.scheduler'

// test-only brief
const brief = (lease: string[], extra: Record<string, unknown> = {}) => ({
  objective: 'Implement it', outputFormat: 'diff', tools: ['Read', 'Edit'], boundaries: 'stay in lease',
  verifyCmd: { file: 'npm', args: ['test'] }, nextAction: 'review', effort: 'simple', lease, ...extra,
})

function outcome(patch: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verifiedBy: SERVER_VERIFIED_BY, ok: true, reasons: [], changedFiles: ['src/a/x.ts'], scopeViolations: [],
    evidence: [{ command: 'npm test', exitCode: 0, durationMs: 1, outputDigest: 'e'.repeat(64), summary: 'exit 0' }],
    tests: { passed: 3, failed: 0, command: 'npm test' }, ...patch,
  }
}

function setup(opts: { behind?: number | null; workers?: boolean; cost?: boolean } = {}) {
  const db = freshDb()
  const clock = { t: T0 }
  const ctx = { db, now: () => clock.t }
  const events: AppendEventInput[] = []
  const spawns: AgentSpawnRequest[] = []
  const verifies: VerifyTaskInput[] = []
  const finish = new Map<string, (o: ExecOutcome) => void>()
  const state = { behind: opts.behind ?? 0 as number | null, verdict: (_i: VerifyTaskInput) => judgeCompletion({ taskId: _i.taskId, verdict: outcome() }) }
  const ports: DagPorts = {
    ctx, record: (e) => { events.push(e) }, workersEnabled: () => opts.workers ?? true,
    behind: async () => state.behind,
    allocate: async (_dag, task, id) => ({ path: `/tmp/st/wt-${task.key}-${id}`, branch: `dag/${task.key}`, baseSha: 'a'.repeat(40) }),
    spawn: async (req) => {
      spawns.push(req)
      let resolve!: (o: ExecOutcome) => void
      const done = new Promise<ExecOutcome>((r) => { resolve = r })
      finish.set(req.nodeId!, resolve)
      return { ok: true, childId: `node:${req.nodeId}`, nodeId: req.nodeId!, depth: 1, name: req.title ?? 'w', handle: { pid: 1, done, tail: () => '', kill: () => {} } }
    },
    verify: async (i) => { verifies.push(i); return state.verdict(i) },
    report: () => {},
    openGate: (g) => createGate(ctx, { projectId: g.projectId, source: 'dag', title: g.title, args: { options: g.options }, impact: { what: 'Unblocks a DAG task', tier: 'R1', rewindable: true } }).approvalId!,
    // The real cost oracle over the same ledger (what costRuntime calls in production).
    ...(opts.cost ? { cost: {
      gate: async (q: { kind: 'dag'; ref: string }) => costGate(db, q),
      begin: async (i: BeginRunInput) => beginCostRun(db, i),
      end: async (id: string | null, o: { producedDiff?: boolean }) => (id ? endCostRun(db, id, o) : null),
    } } : {}),
  }
  const s = createDagScheduler(ports)
  const exit = async (key: string, result = 'finished') => {
    const sp = spawns.filter((x) => x.title?.endsWith(`: ${key}`)).at(-1)!
    finish.get(sp.nodeId!)!({ exitCode: 0, timedOut: false, killed: false, lastEvent: { result }, tail: '' })
    // Only this worker settles; others stay running, so wait for its dispatch row rather than drain().
    const dispatchId = sp.nodeId!.slice('dag-'.length)
    for (let i = 0; i < 200 && s.store.dispatch(dispatchId)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 1))
  }
  const status = (dagId: string) => Object.fromEntries(s.store.tasks(dagId).map((t) => [t.key, t.status]))
  const make = (tasks: unknown[]) => s.store.create({ projectId: 'p1', title: 'Build', repo: '/tmp/st/repo', baseBranch: 'main', createdBy: 'human:loopback', tasks })
  const kinds = () => events.map((e) => e.kind)
  return { db, clock, s, events, spawns, verifies, state, exit, status, make, kinds }
}

test('the v16 tables exist at LATEST_VERSION', () => {
  const { db } = setup()
  expect(Number((db.query('PRAGMA user_version').get() as Record<string, unknown>)['user_version'])).toBe(LATEST_VERSION)
  for (const t of ['dag', 'dag_task', 'dag_dispatch', 'dag_gate']) expect(db.query(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(t)).toBeTruthy()
})

test('overlapping leases are serialized into waves; disjoint ones run in parallel', async () => {
  const h = setup()
  const dag = h.make([{ key: 'a', brief: brief(['src/a/**']) }, { key: 'b', brief: brief(['src/a/x.ts']) }, { key: 'c', brief: brief(['src/c']) }])
  await h.s.tick()
  expect(h.status(dag.id)).toEqual({ a: 'running', b: 'pending', c: 'running' })
  expect(h.kinds()).toContain('dag.task.lease_wait')
  await h.exit('a')
  expect(h.status(dag.id).a).toBe('done')
  await h.s.tick()
  expect(h.status(dag.id).b).toBe('running')
  // Workers are headless Claude Code in their own worktree, brief as the prompt; --tools restricts, --allowedTools pre-approves.
  const sp = h.spawns[0]
  expect(sp).toMatchObject({ mode: 'headless', door: 'orchestrator', parent: 'central' })
  expect(sp.cwd?.startsWith('/tmp/st/wt-a-')).toBe(true)
  expect(sp.headless?.argv).toEqual(['claude', '-p', sp.prompt, '--output-format', 'json', '--tools', 'Read,Edit', '--allowedTools', 'Read,Edit'])
  expect(sp.prompt).toContain('Objective: Implement it')
})

test('done requires the verifier, run with the task lease and verify_cmd; forged evidence never counts', async () => {
  const h = setup()
  const dag = h.make([{ key: 'a', brief: brief(['src/a/**'], { verifyCmd: { file: 'bun', args: ['test', 'src/a'] } }) }])
  // A verdict object that says done but carries unsealed (JSON round-tripped) evidence.
  h.state.verdict = (i) => { const v = judgeCompletion({ taskId: i.taskId, verdict: outcome() }); return { ...v, evidence: JSON.parse(JSON.stringify(v.evidence)) } }
  await h.s.tick()
  await h.exit('a', 'I am done, trust me')
  expect(h.verifies[0]).toMatchObject({ lease: ['src/a/**'], verifyCmd: { file: 'bun', args: ['test', 'src/a'] }, baseRef: 'a'.repeat(40) })
  expect(h.verifies[0].cwd).toBe(h.spawns[0].cwd!)
  expect(h.s.store.task(h.s.store.tasks(dag.id)[0].id)).toMatchObject({ status: 'pending', failureCount: 1 })
  // A lease violation is a failed attempt too.
  h.state.verdict = (i) => judgeCompletion({ taskId: i.taskId, verdict: outcome({ scopeViolations: ['src/b.ts'] }) })
  await h.s.tick()
  await h.exit('a')
  expect(h.s.store.tasks(dag.id)[0]).toMatchObject({ status: 'pending', failureCount: 2 })
  expect(h.s.store.tasks(dag.id)[0].lastError).toContain('lease violation')
  // Sealed, in-lease, green: done.
  h.state.verdict = (i) => judgeCompletion({ taskId: i.taskId, verdict: outcome() })
  await h.s.tick()
  await h.exit('a')
  expect(h.status(dag.id).a).toBe('done')
  expect(h.s.store.get(dag.id)?.status).toBe('done')
  expect(h.kinds()).toEqual(expect.arrayContaining(['dag.task.running', 'dag.task.requeued', 'dag.task.done', 'dag.done']))
})

test('the breaker trips on the 3rd failure and the dag fails', async () => {
  const h = setup()
  const dag = h.make([{ key: 'a', brief: brief(['src']) }, { key: 'b', deps: ['a'], brief: brief(['docs']) }])
  h.state.verdict = (i) => judgeCompletion({ taskId: i.taskId, verdict: outcome({ changedFiles: [] }) })
  for (let i = 0; i < 3; i++) { await h.s.tick(); await h.exit('a') }
  await h.s.tick()
  expect(h.spawns.length).toBe(3)
  expect(h.s.store.tasks(dag.id)[0]).toMatchObject({ status: 'failed', failureCount: 3, lastError: 'Circuit broken: no changes' })
  expect(h.kinds().filter((k) => k === 'dag.task.requeued').length).toBe(2)
  expect(h.kinds()).toContain('dag.task.circuit_broken')
  expect(h.s.store.get(dag.id)?.status).toBe('failed')
})

test('a stale base is refused before any dispatch and costs no breaker strike; allow-stale-base opts out', async () => {
  const h = setup({ behind: 25 })
  const dag = h.make([{ key: 'a', brief: brief(['src']) }, { key: 'b', brief: brief(['docs'], { allowStaleBase: true }) }])
  await h.s.tick()
  expect(h.status(dag.id)).toEqual({ a: 'pending', b: 'running' })
  expect(h.s.store.tasks(dag.id)[0].failureCount).toBe(0)
  expect(h.events.find((e) => e.kind === 'dag.dispatch.stale_base_refused')?.payload).toMatchObject({ behind: 25, threshold: 20 })
  h.state.behind = 20
  await h.s.tick()
  expect(h.status(dag.id).a).toBe('running')
})

test('a gate node blocks dependents until a human decides; agents get 403; a pending gate is reblocked', async () => {
  const h = setup()
  const dag = h.make([
    { key: 'gate', kind: 'gate', brief: { objective: 'Ship the migration?', nextAction: 'run b', options: ['now', 'tonight'] } },
    { key: 'b', deps: ['gate'], brief: brief(['src']) },
  ])
  await h.s.tick()
  expect(h.status(dag.id)).toEqual({ gate: 'blocked', b: 'pending' })
  const [gate] = h.s.store.gates(dag.id)
  expect(h.db.query('SELECT status FROM approval WHERE id = ?').get(gate.approvalId)).toEqual({ status: 'pending' })
  // Anything that flips the task away from blocked is undone while the gate is pending.
  h.s.store.setTask(gate.taskId, { status: 'pending' })
  await h.s.tick()
  expect(h.status(dag.id).gate).toBe('blocked')
  expect(h.events.some((e) => e.kind === 'dag.task.blocked' && (e.payload as { reblocked?: boolean }).reblocked)).toBe(true)
  expect(h.spawns.length).toBe(0)

  const deps: DagApiDeps = { ctx: { db: h.db, now: () => h.clock.t }, scheduler: h.s, isNodeToken: (t) => t === 'node-tok', record: (e) => { h.events.push(e) } }
  const req = (headers: Record<string, string>) => ({ method: 'POST', headers: { host: '127.0.0.1:8700', ...headers } }) as unknown as IncomingMessage
  const url = new URL(`http://127.0.0.1:8700/api/dag/gates/${gate.id}/decide`)
  const agent = await handleDagApi(deps, req({ 'x-webterm-token': 'node-tok', 'sec-fetch-site': 'same-origin' }), url, { approve: true })
  expect(agent?.status).toBe(403)
  expect((await handleDagApi(deps, req({}), url, { approve: true }))?.status).toBe(403) // plain curl, no browser
  expect(h.status(dag.id).gate).toBe('blocked')

  const human = req({ 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8700' })
  expect((await handleDagApi(deps, human, url, { approve: true, option: 'never' }))?.status).toBe(400)
  const ok = await handleDagApi(deps, human, url, { approve: true, option: 'tonight' })
  expect(ok?.status).toBe(200)
  expect(h.status(dag.id)).toEqual({ gate: 'done', b: 'running' })
  expect(h.s.store.gate(gate.id)?.status).toBe('approved')
  expect(h.kinds()).toEqual(expect.arrayContaining(['dag.gate.opened', 'dag.gate.approved', 'inbox.decision']))
  expect((await handleDagApi(deps, human, url, { approve: true }))?.status).toBe(409)
})

test('a worker-raised decision gate blocks the task; the human answer is in the next brief; deny fails it', async () => {
  const h = setup()
  const dag = h.make([{ key: 'a', brief: brief(['src']) }])
  await h.s.tick()
  await h.exit('a', 'stuck\nDECISION_GATE: {"question": "Keep the old API?", "options": ["keep", "drop"]}')
  expect(h.status(dag.id).a).toBe('blocked')
  expect(h.verifies.length).toBe(0)
  const [gate] = h.s.store.gates(dag.id)
  expect(gate).toMatchObject({ question: 'Keep the old API?', options: ['keep', 'drop'], dispatchId: expect.any(String) })
  h.db.query(`UPDATE approval SET status = 'approved', approved_by = 'human:loopback' WHERE id = ?`).run(gate.approvalId)
  await h.s.tick()
  expect(h.status(dag.id).a).toBe('running')
  expect(h.spawns[1].prompt).toContain('A human decided earlier: Keep the old API?: approved')

  await h.exit('a', 'DECISION_GATE: {"question": "Delete prod data?"}')
  const second = h.s.store.gates(dag.id)[1]
  h.db.query(`UPDATE approval SET status = 'rejected' WHERE id = ?`).run(second.approvalId)
  await h.s.tick()
  expect(h.s.store.tasks(dag.id)[0]).toMatchObject({ status: 'failed', lastError: 'decision gate denied' })
})

test('escalation is bound to the exact dispatch and its owner; it counts one strike', async () => {
  const h = setup()
  const dag = h.make([{ key: 'a', brief: brief(['src']) }, { key: 'b', brief: brief(['docs']) }])
  await h.s.tick()
  const [a, b] = h.s.store.tasks(dag.id)
  const da = h.db.query('SELECT id, node_id FROM dag_dispatch WHERE task_id = ?').get(a.id) as { id: string; node_id: string }
  const db_ = h.db.query('SELECT id FROM dag_dispatch WHERE task_id = ?').get(b.id) as { id: string }
  expect(h.s.escalate({ taskId: a.id, dispatchId: db_.id, from: da.node_id, reason: 'x' })).toBe('rejected')
  expect(h.s.escalate({ taskId: a.id, dispatchId: da.id, from: 'dag-intruder', reason: 'x' })).toBe('rejected')
  expect(h.kinds().filter((k) => k === 'dag.escalation.rejected').length).toBe(2)
  expect(h.s.escalate({ taskId: a.id, dispatchId: da.id, from: da.node_id, reason: 'needs a db' })).toBe('retry')
  expect(h.s.store.task(a.id)).toMatchObject({ status: 'pending', failureCount: 1, lastError: 'escalated: needs a db' })
  // An escalation line in the worker output goes through the same binding.
  await h.exit('b', 'ESCALATE: no credentials')
  expect(h.s.store.task(b.id)).toMatchObject({ status: 'pending', failureCount: 1 })
})

test('workers switched off dispatch nothing; restart abandons orphans without a strike', async () => {
  const off = setup({ workers: false })
  const d1 = off.make([{ key: 'a', brief: brief(['src']) }])
  await off.s.tick()
  expect(off.status(d1.id).a).toBe('pending')
  expect(off.kinds()).toContain('dag.dispatch.workers_off')

  const h = setup()
  const dag = h.make([{ key: 'a', brief: brief(['src']) }])
  await h.s.tick()
  const fresh = createDagScheduler({ ...({} as DagPorts), ctx: { db: h.db, now: () => h.clock.t }, record: () => {} })
  fresh.recoverOrphans()
  expect(h.s.store.tasks(dag.id)[0]).toMatchObject({ status: 'pending', failureCount: 0 })
})

test('API: create validates the brief, previews waves; reads are open, writes UI-only', async () => {
  const h = setup()
  const deps: DagApiDeps = { ctx: { db: h.db, now: () => h.clock.t }, scheduler: h.s, isNodeToken: () => false, record: () => {} }
  const human = { method: 'POST', headers: { host: '127.0.0.1:8700', 'sec-fetch-site': 'same-origin' } } as unknown as IncomingMessage
  const url = new URL('http://127.0.0.1:8700/api/dag')
  const body = { projectId: 'p1', title: 'T', repo: '/tmp/st/repo', tasks: [{ key: 'a', brief: brief(['src/a']) }, { key: 'b', brief: brief(['src/a/b']) }] }
  const bad = await handleDagApi(deps, human, url, { ...body, tasks: [{ key: 'a', brief: { objective: 'x' } }] })
  expect(bad).toMatchObject({ status: 400, body: { error: 'invalid_brief' } })
  expect((await handleDagApi(deps, human, url, { ...body, projectId: 'nope' }))?.status).toBe(404)
  const created = await handleDagApi(deps, human, url, body)
  // No cost history yet: the plan says so instead of inventing a number.
  expect(created).toMatchObject({ status: 201, body: { waves: [['a'], ['b']], estimate: { tasks: 2, medianMicros: null, totalMicros: null, basis: 'none' } } })
  const id = (created!.body as { dag: { id: string } }).dag.id
  const get = { method: 'GET', headers: {} } as unknown as IncomingMessage
  execWrite(h.db, 'INSERT INTO cost_run (id, kind, ref, started_at, ended_at, cost_micros) VALUES (?, ?, ?, ?, ?, ?)', 'c1', 'dag', id, 1, 2, 300_000)
  expect(await handleDagApi(deps, get, new URL(`http://x/api/dag/${id}`), {})).toMatchObject({ status: 200, body: { tasks: expect.any(Array), waves: [['a'], ['b']], estimate: { tasks: 2, medianMicros: 300_000, totalMicros: 600_000, basis: 'ref' } } })
  expect((await handleDagApi(deps, get, new URL('http://x/api/dag?limit=10'), {}))?.body).toMatchObject({ dags: [{ id }] })
  expect(h.kinds()).toContain('dag.created')
  expect(await handleDagApi(deps, get, new URL('http://x/api/dagger'), {})).toBeNull()
})

test('worker argv: --tools takes bare names, --allowedTools keeps scoped rules; no tools = none available', () => {
  expect(dagWorkerArgv('p', ['Read', 'Bash(git diff *)', 'Bash(git log *)']).slice(5)).toEqual(['--tools', 'Read,Bash', '--allowedTools', 'Read,Bash(git diff *),Bash(git log *)'])
  expect(dagWorkerArgv('p', []).slice(5)).toEqual(['--tools', ''])
})

test('cost: each dispatch opens a window closed with the verifier diff; a used-up dag cap holds tasks pending', async () => {
  const h = setup({ cost: true })
  const dag = h.make([{ key: 'a', brief: brief(['src/a/**']) }, { key: 'b', deps: ['a'], brief: brief(['src/b']) }])
  await h.s.tick()
  await h.exit('a') // verifier: src/a/x.ts changed
  await h.s.drain() // the cost window closes after settle
  const runs = h.db.query('SELECT kind, ref, node_id, produced_diff, ended_at FROM cost_run').all() as Record<string, unknown>[]
  expect(runs).toEqual([{ kind: 'dag', ref: dag.id, node_id: h.spawns[0].nodeId, produced_diff: 1, ended_at: expect.any(Number) }])
  const now = Date.now() // the oracle's own clock
  execWrite(h.db, 'UPDATE cost_run SET started_at = ?, cost_micros = ?', now, 5_000_000)
  setCostCap(h.db, `dag:${dag.id}`, 1_000_000)
  await h.s.tick()
  expect(h.status(dag.id).b).toBe('pending')
  expect(h.spawns).toHaveLength(1)
  const refused = h.events.find((e) => e.kind === 'dag.dispatch.cost_refused')
  expect(refused?.payload).toMatchObject({ reason: 'budget', estimateMicros: 5_000_000 })
  expect(h.s.store.get(dag.id)?.status).toBe('active') // waits for the cap to be raised, not failed
})
