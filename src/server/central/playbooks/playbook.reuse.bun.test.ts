// Bun-only (real ledger schema): a playbook hands its task to a finished agent instead of spawning, and every refusal
// (one test row per code) spawns as before. Fake ports and a fake step executor: no sessions, no browser, no network.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'playbook-reuse-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.WEBTERM_CENTRAL_RUNTIME = 'mock' // test-only: notices publish on the mock runtime's stream hub

const { freshDb, rows, run: sql, T0 } = await import('../guard/controlGuard.testutil')
const { createRegistry } = await import('../tools/toolRegistry')
const { ALLOW_ALL_GUARD } = await import('../tools/toolExec')
const { playbookById } = await import('./playbook.defs')
const { runPlaybook } = await import('./playbook.run')
const { MAX_AGE_MS, MAX_REUSES, pickReusableAgent } = await import('../agents/agentReuse')
const { createWorkStore } = await import('../work/workStore')
const { putTaskInStatus } = await import('../work/workRig.testutil')
type Db = ReturnType<typeof freshDb>
type Ctx = import('../tools/toolTypes').ToolCtx
type Exec = import('../tools/toolTypes').ExecResult

let db: Db
let clock = T0
let calls: Array<{ tool: string; args: Record<string, unknown> }>
let script: Record<string, Exec[]>
let live: boolean
let focus: string | null
let cabled: Record<string, string[]>
let busy: Set<string>
let idle: string[]
let linked: Array<[string, string]>
let linkOk: boolean
const deps = () => ({
  exec: async (_ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<Exec> => {
    calls.push({ tool, args })
    return script[tool]?.shift() ?? { ok: true, tool, data: tool === 'task.create' ? { taskId: 'task-1' } : tool === 'agent.spawn' ? { agentId: 'ag-new', state: 'working' } : tool === 'browser_open' ? { nodeId: args.nodeId } : {} }
  },
  record: () => undefined,
  reuse: {
    hasSession: () => live, focusedNode: () => focus, cabledBrowsers: (n: string) => cabled[n] ?? [], browserBusy: (b: string) => busy.has(b),
    idleBrowsers: () => idle, link: (a: string, b: string) => { linked.push([a, b]); return linkOk },
  },
})
let ctx: Ctx
const pb = (id: string) => playbookById(id) as NonNullable<ReturnType<typeof playbookById>>
const tools = () => calls.map((c) => c.tool)
const events = () => rows(db, "SELECT payload_json FROM event WHERE kind = 'central.agent'").map((r) => JSON.parse(String(r.payload_json)) as Record<string, unknown>).filter((p) => String(p.phase).startsWith('reuse.'))
const budget = (id = 'ag-old') => JSON.parse(String(rows(db, 'SELECT budget_json FROM central_agents WHERE id = ?', id)[0]?.budget_json)) as { ladder: { pick: { tier: string } }; reuse?: { count: number } }
const fire = (goal = 'compare sqlite orms') => runPlaybook(ctx, pb('web_research'), { goal }, 'p1', deps())

/** One finished web_research agent whose result Central already received: passes every check until a test breaks one. */
function seedValid(): void {
  const store = createWorkStore(db, () => clock)
  store.createTask({ id: 'old-task', projectId: 'p1', title: 'old', objective: 'old', actor: { kind: 'human', id: 't' } })
  putTaskInStatus(store, 'old-task', 'needs_review')
  sql(db, `INSERT INTO central_agents (id, project_id, kind, role, runner, task_id, state, owner, req_id, budget_json, node_id, started_at, last_event_at)
    VALUES ('ag-old', 'p1', 'claude', 'worker', 'pty', 'old-task', 'candidate_done', 'central:project:p1', 'req-old', ?, 'n-old', ?, ?)`,
  JSON.stringify({ ladder: { complexity: 'moderate', pick: { model: 'm', effort: 'medium', tier: 'T2', reason: 'default' } } }), clock - 60_000, clock - 1000)
  sql(db, "INSERT INTO central_checkin_reason (id, dedupe_key, kind, project_id, task_id, text, created_at, sent_at) VALUES ('r1', 'k1', 'task_report', 'p1', 'old-task', 'x', ?, ?)", clock - 5000, clock - 4000)
  sql(db, `INSERT INTO central_playbook_run (id, playbook, project_id, conversation_id, call_key, params_json, saved_json, status, created_at, updated_at)
    VALUES ('pb_old', 'web_research', 'p1', 'c', 'old', '{}', '{"agent":{"agentId":"ag-old"}}', 'done', ?, ?)`, clock - 60_000, clock - 60_000)
}
const set = (column: string, value: unknown) => sql(db, `UPDATE central_agents SET ${column} = ? WHERE id = 'ag-old'`, value)

beforeEach(() => {
  db = freshDb(); clock = T0; calls = []; script = {}; live = true; focus = null; cabled = { 'n-old': ['br-old'] }; busy = new Set(); idle = []; linked = []; linkOk = true
  ctx = { db, registry: createRegistry(), guard: ALLOW_ALL_GUARD, maxTier: 'R3', conversationId: 'central:project:p1', now: () => clock, env: {} }
  seedValid()
})
afterEach(() => db.close())
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('policy: a qualifying finished agent always takes the task', () => {
  test('no agent.spawn and no new browser; a followup with the NEW task, then the result says so', async () => {
    const r = await fire()
    expect(tools()).toEqual(['task.create', 'agent.prompt'])
    expect(r).toMatchObject({ ok: true, data: { status: 'started', agentId: 'ag-old', reused: true, browserNodeId: 'br-old', taskId: 'task-1' } })
    expect(String(r.data?.note)).toContain('reused')
  })

  test('the followup carries the new task id, the marker and a brief naming the reused browser; the reuse is counted', async () => {
    await fire('best bun orm')
    const prompt = calls.find((c) => c.tool === 'agent.prompt')
    expect(prompt?.args).toMatchObject({ projectId: 'p1', agentRef: 'ag-old', mode: 'followup', taskId: 'task-1' })
    const text = String(prompt?.args.text)
    expect(text.startsWith('new task: ignore earlier tasks except your tool state; report with a RESULT line')).toBe(true)
    expect(text).toContain('Objective: best bun orm')
    expect(text).toContain('browser node br-old')
    expect(String(calls[0]?.args.objective)).toContain('browser node br-old') // the board task names the same browser
    expect(budget().reuse?.count).toBe(1)
    expect(budget().ladder.pick.tier).toBe('T2') // the ladder's decision is kept next to the counter
    expect(events().map((e) => e.phase)).toEqual(['reuse.chosen'])
    expect(events()[0]).toMatchObject({ agentId: 'ag-old', browserNodeId: 'br-old' })
  })
})

describe('every refusal spawns a new agent, with its own recorded reason', () => {
  const cases: Array<[string, string, () => void]> = [
    ['state_working', 'working', () => set('state', 'working')],
    ['state_waiting_input', 'waiting_input', () => set('state', 'waiting_input')],
    ['session_gone', 'dead session', () => { live = false }],
    ['tier_mismatch', 'other model tier', () => set('budget_json', JSON.stringify({ ladder: { pick: { model: 'm', effort: 'low', tier: 'T1', reason: 'r' } } }))],
    ['result_not_delivered', 'result still queued', () => sql(db, 'UPDATE central_checkin_reason SET sent_at = NULL')],
    ['result_not_delivered', 'a second reason unsent', () => sql(db, "INSERT INTO central_checkin_reason (id, dedupe_key, kind, project_id, task_id, text, created_at) VALUES ('r2', 'k2', 'task_input', 'p1', 'old-task', 'x', 1)")],
    ['task_not_settled', 'task still running', () => putTaskInStatus(createWorkStore(db, () => clock), 'old-task', 'running')],
    ['in_use', 'user focused on the agent', () => { focus = 'n-old' }],
    ['in_use', 'user focused on its browser', () => { focus = 'br-old' }],
    ['in_use', 'browser lease busy', () => { busy.add('br-old') }],
    ['project_mismatch', 'other project', () => set('project_id', 'p2')],
    ['owner_not_central', 'user-owned', () => set('owner', 'human')],
    ['too_many_reuses', 'reuse limit', () => set('budget_json', JSON.stringify({ ladder: { pick: { model: 'm', effort: 'medium', tier: 'T2', reason: 'r' } }, reuse: { count: MAX_REUSES } }))],
    ['too_old', 'age limit', () => set('started_at', T0 - MAX_AGE_MS - 1)],
    ['playbook_class_mismatch', 'earlier run was code_change', () => sql(db, "UPDATE central_playbook_run SET playbook = 'code_change'")],
    ['playbook_class_mismatch', 'spawned outside a playbook', () => sql(db, 'DELETE FROM central_playbook_run')],
    ['role_or_kind_mismatch', 'other role', () => set('role', 'reviewer')],
    ['role_or_kind_mismatch', 'other kind', () => set('kind', 'codex')],
    ['not_pty', 'headless runner', () => set('runner', 'exec')],
  ]
  for (const [code, label, breakIt] of cases) test(`${code} (${label})`, async () => {
    breakIt()
    const r = await fire()
    expect(tools()).toEqual(['task.create', 'agent.spawn', 'browser_open'])
    expect(r).toMatchObject({ ok: true, data: { agentId: 'ag-new', reused: false } })
    const none = events().find((e) => e.phase === 'reuse.none')
    // a pty-only scan never lists the headless agent at all: the refusal is simply "no candidate"
    expect(JSON.stringify(none?.rejected ?? [])).toContain(code === 'not_pty' ? '[]' : code)
    expect(calls.some((c) => c.tool === 'agent.prompt')).toBe(false)
  })

  test('code_change never reuses, even with a perfect candidate', async () => {
    const r = await runPlaybook(ctx, pb('code_change'), { goal: 'fix the login redirect' }, 'p1', deps())
    expect(tools()).toEqual(['task.create', 'agent.spawn'])
    expect(r.data?.reused).toBe(false)
    expect(pickReusableAgent(db, deps().reuse, { projectId: 'p1', role: 'worker', kind: 'claude', playbookId: 'code_change' }, () => clock).rejected).toEqual([{ agentId: null, reason: 'playbook_not_reusable' }])
  })

  test('an unknown playbook id is treated as not reusable', () => {
    expect(pickReusableAgent(db, deps().reuse, { projectId: 'p1', role: 'worker', kind: 'claude', playbookId: 'whatever' }, () => clock).pick).toBeNull()
  })
})

describe('the browser of a reused agent', () => {
  test('no cable but an idle browser on the board: it is re-cabled to the agent (after the followup) and no browser opens', async () => {
    cabled = {}
    idle = ['br-idle']
    const r = await fire()
    expect(tools()).toEqual(['task.create', 'agent.prompt'])
    expect(linked).toEqual([['n-old', 'br-idle']])
    expect(r.data).toMatchObject({ reused: true, browserNodeId: 'br-idle' })
    expect(String(calls[1]?.args.text)).toContain('browser node br-idle')
  })

  test('a refused re-cable is recorded and the agent still got its task (it opens its own browser)', async () => {
    cabled = {}
    idle = ['br-idle']
    linkOk = false
    const r = await fire()
    expect(r).toMatchObject({ ok: true, data: { reused: true, browserNodeId: null } })
    expect(events().map((e) => e.phase)).toEqual(['reuse.chosen', 'reuse.browser_link_refused'])
  })

  test('no cable and nothing idle: a new browser is opened and cabled as before', async () => {
    cabled = {}
    const r = await fire()
    const runId = String(r.data?.runId)
    expect(tools()).toEqual(['task.create', 'agent.prompt', 'browser_open'])
    expect(calls[2]?.args).toEqual({ projectId: 'p1', agentRef: 'ag-old', nodeId: `br-${runId}` })
    expect(String(calls[1]?.args.text)).toContain(`browser node br-${runId}`)
    expect(r.data).toMatchObject({ reused: true, browserNodeId: `br-${runId}` })
  })
})

describe('a reuse that fails mid-way', () => {
  test('the followup is refused: ONE normal spawn follows, once, and the fallback is recorded', async () => {
    script['agent.prompt'] = [{ ok: false, tool: 'agent.prompt', code: 'agent_not_active' }]
    const r = await fire()
    expect(tools()).toEqual(['task.create', 'agent.prompt', 'agent.spawn', 'browser_open'])
    expect(r).toMatchObject({ ok: true, data: { agentId: 'ag-new', reused: false } })
    expect(budget().reuse).toBe(undefined) // a failed hand-over is not counted
    expect(events().map((e) => e.phase)).toEqual(['reuse.chosen', 'reuse.fallback'])
    expect(events()[1]).toMatchObject({ agentId: 'ag-old', error: 'agent_not_active' })
  })

  test('a followup that throws also falls back to the spawn', async () => {
    const d = deps()
    const exec = d.exec
    const r = await runPlaybook(ctx, pb('web_research'), { goal: 'x' }, 'p1', { ...d, exec: async (c, t, a) => { if (t === 'agent.prompt') throw new Error('pty gone'); return exec(c, t, a) } })
    expect(r).toMatchObject({ ok: true, data: { agentId: 'ag-new', reused: false } })
    expect(events().map((e) => e.phase)).toEqual(['reuse.chosen', 'reuse.fallback'])
  })
})

describe('without a candidate the old behaviour is unchanged', () => {
  test('no finished agent: task.create -> spawn -> browser_open, reused false, nothing counted', async () => {
    set('state', 'working')
    const r = await fire()
    expect(tools()).toEqual(['task.create', 'agent.spawn', 'browser_open'])
    expect(r.data).toMatchObject({ agentId: 'ag-new', reused: false, browserNodeId: `br-${String(r.data?.runId)}` })
  })

  test('without ports (deps.reuse absent) the run never looks at agents', async () => {
    const { reuse: _unused, ...plain } = deps()
    const r = await runPlaybook(ctx, pb('web_research'), { goal: 'x' }, 'p1', plain)
    expect(tools()).toEqual(['task.create', 'agent.spawn', 'browser_open'])
    expect(r.data?.reused).toBe(false)
    expect(events()).toEqual([])
  })
})
