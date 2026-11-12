// Bun-only (real ledger schema): each playbook's chain with a fake step executor, the cursor parked on an approval
// card and continued by the decision hook, receipts, and the notices. Temp HOME / data dir / Claude dir so db.ts and
// the Claude config never touch the user's files. No real Claude, no real agents: the executor is a fake.
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'playbook-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.WEBTERM_CENTRAL_RUNTIME = 'mock' // test-only: notices publish on the mock runtime's stream hub

const { freshDb, rows, T0 } = await import('../guard/controlGuard.testutil')
const { decideApproval, requestApproval } = await import('../../ledger/ledgerApproval')
const { getRow } = await import('../../ledger/ledgerCore')
const { createRegistry } = await import('../tools/toolRegistry')
const { ALLOW_ALL_GUARD } = await import('../tools/toolExec')
const { PLAYBOOKS, playbookById } = await import('./playbook.defs')
const { REPLAY_WINDOW_MS, resumeOnApproval, runPlaybook, watchPlaybookApprovals } = await import('./playbook.run')
const { createPlaybookDefs } = await import('./playbook.tools')
type Db = ReturnType<typeof freshDb>
type Ctx = import('../tools/toolTypes').ToolCtx
type Exec = import('../tools/toolTypes').ExecResult

let db: Db
let clock = T0
let calls: Array<{ tool: string; args: Record<string, unknown>; ctx: Ctx }>
let script: Record<string, Exec[]>
const records: string[] = []
const deps = {
  exec: async (ctx: Ctx, tool: string, args: Record<string, unknown>): Promise<Exec> => {
    calls.push({ tool, args, ctx })
    const next = script[tool]?.shift()
    return next ?? { ok: true, tool, data: tool === 'task.create' ? { taskId: 'task-1' } : tool === 'agent.spawn' ? { agentId: 'ag-1', state: 'working' } : {} }
  },
  record: (e: { kind: string; payload?: unknown }) => { records.push(`${e.kind} ${JSON.stringify((e.payload as { text?: string }).text)}`) },
}
let sleeps = 0
const waitDeps = { ...deps, activeWaitMs: 6_000, sleep: async () => { sleeps += 1 } }
const ctxFor = (conversationId: string): Ctx => ({ db, registry: createRegistry(), guard: ALLOW_ALL_GUARD, maxTier: 'R3', conversationId, now: () => clock, env: {} })
let ctx: Ctx
const pb = (id: string) => playbookById(id) as NonNullable<ReturnType<typeof playbookById>>
const runRow = () => getRow(db, 'SELECT * FROM central_playbook_run ORDER BY created_at DESC LIMIT 1') as Record<string, unknown>

beforeEach(() => { db = freshDb(); clock = T0; calls = []; script = {}; records.length = 0; sleeps = 0; ctx = ctxFor('central:project:p1') })
afterEach(() => db.close())
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('registry', () => {
  test('three playbooks, each one Central tool over task.create -> agent.spawn -> agent.prompt', () => {
    expect(createPlaybookDefs().map((d) => d.name)).toEqual(['playbook.review', 'playbook.code_change', 'playbook.web_research'])
    for (const p of PLAYBOOKS) expect(p.steps.map((s) => s.tool)).toEqual(['task.create', 'agent.spawn', 'agent.prompt'])
  })

  test('web_research: the task carries the brief, the agent the task, the steer opens the browser at the url', async () => {
    const r = await runPlaybook(ctx, pb('web_research'), { goal: 'analyse GitHub trending today', url: 'https://github.com/trending' }, 'p1', deps)
    expect(r).toMatchObject({ ok: true, data: { taskId: 'task-1', step: 'agent.prompt', status: 'done', agentId: 'ag-1' } })
    const [task, spawn, prompt] = calls
    expect(task?.args).toMatchObject({ projectId: 'p1', title: 'web research: analyse GitHub trending today', acceptance: 'review' })
    expect(spawn?.args).toMatchObject({ projectId: 'p1', role: 'worker', kind: 'claude', taskId: 'task-1', requestId: `pb-${String(r.data?.runId)}` })
    expect(prompt?.args).toMatchObject({ agentRef: 'ag-1', mode: 'steer', taskId: 'task-1' })
    const text = String(prompt?.args.text)
    expect(text).toContain('webterm-browser open https://github.com/trending')
    expect(text).toContain('RESULT:')
    expect(text).toContain('Sources')
    expect(text).toMatch(/Objective: .*Output format: .*Boundaries: /s)
    expect(records).toEqual(['auto.playbook_started "Central started web research: analyse GitHub trending today"'])
  })

  test('web_research without a url searches for the goal', async () => {
    await runPlaybook(ctx, pb('web_research'), { goal: 'best sqlite orm' }, 'p1', deps)
    expect(String(calls[2]?.args.text)).toContain('webterm-browser open https://duckduckgo.com/?q=best%20sqlite%20orm')
  })

  test('code_change uses a worker, review a reviewer that may not change files', async () => {
    await runPlaybook(ctx, pb('code_change'), { goal: 'fix the login redirect' }, 'p1', deps)
    expect(calls[1]?.args.role).toBe('worker')
    expect(String(calls[2]?.args.text)).toContain('do not push')
    calls = []
    await runPlaybook(ctx, pb('review'), { target: 'PR #42' }, 'p1', deps)
    expect(calls[1]?.args.role).toBe('reviewer')
    expect(String(calls[2]?.args.text)).toContain('Objective: Review PR #42')
    expect(String(calls[2]?.args.text)).toContain('Read only')
  })

  test('only the spawn step sees a guard approval_required as a pass; other steps keep the verdict', async () => {
    const strict = { check: () => ({ ok: false as const, code: 'approval_required' }) }
    const deny = { check: () => ({ ok: false as const, code: 'level_denied' }) }
    const req = { tool: 't', tier: 'R2' as const, input: {} }
    await runPlaybook({ ...ctx, guard: strict }, pb('code_change'), { goal: 'y' }, 'p1', deps)
    expect(calls.map((c) => [c.tool, c.ctx.guard.check(req).ok])).toEqual([['task.create', false], ['agent.spawn', true], ['agent.prompt', false]])
    calls = []
    await runPlaybook({ ...ctx, guard: deny }, pb('code_change'), { goal: 'z' }, 'p1', deps)
    expect(calls[1]?.ctx.guard.check(req)).toEqual({ ok: false, code: 'level_denied' })
  })
})

describe('approval cursor', () => {
  const card = (id: string) => requestApproval({ db, now: () => clock }, { id, projectId: 'p1', kind: 'agent.spawn', request: { agentId: 'ag-1' } })
  const decide = (id: string, approve: boolean) => {
    const d = getRow(db, 'SELECT d.action_digest, d.nonce FROM approval a JOIN decision d ON d.id = a.decision_id WHERE a.id = ?', id) as Record<string, unknown>
    decideApproval({ db, now: () => clock }, id, { actor: 'human:test', approve, digest: String(d.action_digest), nonce: String(d.nonce) })
  }
  const parkOnCard = async () => {
    card('agent-ag-1')
    script['agent.spawn'] = [{ ok: false, tool: 'agent.spawn', code: 'approval_required', data: { agentId: 'ag-1', approvalId: 'agent-ag-1', approvalStatus: 'pending' } }]
    return runPlaybook(ctx, pb('web_research'), { goal: 'compare bun and node' }, 'p1', deps)
  }

  test('approval_required parks the run with its step, saved ids and the card, and returns a receipt', async () => {
    const r = await parkOnCard()
    expect(r).toMatchObject({ ok: false, code: 'approval_required', data: { taskId: 'task-1', step: 'agent.spawn', status: 'waiting', approvalId: 'agent-ag-1', approvalStatus: 'pending' } })
    const row = runRow()
    expect(row).toMatchObject({ status: 'waiting', step_index: 1, approval_id: 'agent-ag-1', project_id: 'p1', conversation_id: 'central:project:p1' })
    expect(JSON.parse(String(row.saved_json))).toEqual({ task: { taskId: 'task-1' } })
  })

  test('the decision hook continues the run from the parked step once the card is approved', async () => {
    const r = await parkOnCard()
    const stop = watchPlaybookApprovals(ctxFor, deps)
    try {
      decide('agent-ag-1', true)
      for (let i = 0; i < 20 && runRow().status !== 'done'; i++) await new Promise((res) => setTimeout(res, 5))
    } finally { stop() }
    expect(runRow()).toMatchObject({ status: 'done', step_index: 3 })
    // task.create ran once; the spawn retried with the same requestId (the executor's own card resolves it).
    expect(calls.map((c) => c.tool)).toEqual(['task.create', 'agent.spawn', 'agent.spawn', 'agent.prompt'])
    expect(calls[2]?.args.requestId).toBe(calls[1]?.args.requestId)
    expect(calls[2]?.args.requestId).toBe(`pb-${String(r.data?.runId)}`)
    expect(records.at(-1)).toBe('auto.playbook_resumed "Central resumed web research after approval: compare bun and node"')
  })

  test('a rejected card ends the run and tells the user; a second decision event changes nothing', async () => {
    await parkOnCard()
    decide('agent-ag-1', false)
    const approval = { id: 'agent-ag-1', status: 'rejected' } as Parameters<typeof resumeOnApproval>[2]
    expect(await resumeOnApproval(db, ctxFor, approval, deps)).toMatchObject({ ok: false, code: 'approval_rejected', data: { status: 'rejected' } })
    expect(runRow()).toMatchObject({ status: 'rejected' })
    expect(await resumeOnApproval(db, ctxFor, approval, deps)).toBeNull()
    expect(calls.map((c) => c.tool)).toEqual(['task.create', 'agent.spawn'])
    expect(records.at(-1)).toContain('auto.playbook_stopped')
  })

  test('a retry of the same call resumes the parked run instead of starting a second one', async () => {
    await parkOnCard()
    const again = await runPlaybook(ctx, pb('web_research'), { goal: 'compare bun and node' }, 'p1', deps)
    expect(again).toMatchObject({ ok: true, data: { status: 'done' } })
    expect(rows(db, 'SELECT id FROM central_playbook_run')).toHaveLength(1)
    expect(calls.filter((c) => c.tool === 'task.create')).toHaveLength(1)
  })
})

describe('receipts', () => {
  test('a finished identical call replays its receipt inside the window, runs anew after it', async () => {
    const first = await runPlaybook(ctx, pb('review'), { target: 'branch x' }, 'p1', deps)
    const replay = await runPlaybook(ctx, pb('review'), { target: 'branch x' }, 'p1', deps)
    expect(replay.data).toMatchObject({ runId: first.data?.runId, status: 'done', replayed: true })
    clock += REPLAY_WINDOW_MS + 1
    const fresh = await runPlaybook(ctx, pb('review'), { target: 'branch x' }, 'p1', deps)
    expect(fresh.data?.runId).not.toBe(first.data?.runId)
  })

  test('a failing step stops the run with its code and step', async () => {
    script['agent.prompt'] = [{ ok: false, tool: 'agent.prompt', code: 'session_gone' }]
    const r = await runPlaybook(ctx, pb('code_change'), { goal: 'add a flag' }, 'p1', deps)
    expect(r).toMatchObject({ ok: false, code: 'session_gone', data: { taskId: 'task-1', step: 'agent.prompt', status: 'failed' } })
    expect(runRow()).toMatchObject({ status: 'failed', code: 'session_gone', step_index: 2 })
  })

  test('the tool validates its input: required goal, http(s) url, no unknown keys', () => {
    const def = createPlaybookDefs().find((d) => d.name === 'playbook.web_research')
    const v = (input: Record<string, unknown>) => def?.validate({ projectId: 'p1', ...input }, ctx)
    expect(v({ goal: 'x', url: 'https://a.dev' })).toBeNull()
    expect(v({ goal: ' ' })).toBe('invalid_shape')
    expect(v({ goal: 'x', url: 'javascript:alert(1)' })).toBe('invalid_shape')
    expect(v({ goal: 'x', extra: 'y' })).toBe('invalid_shape')
  })
})

describe('waiting for the approved agent to become active', () => {
  const provisioning = (): Exec => ({ ok: true, tool: 'agent.spawn', data: { agentId: 'ag-1', state: 'provisioning' } })
  const status = (state: string, endedAt: number | null = null): Exec => ({ ok: true, tool: 'agent.status', data: { agentId: 'ag-1', state, endedAt } })

  test('polls agent.status until the agent works, then prompts', async () => {
    script['agent.spawn'] = [provisioning()]
    script['agent.status'] = [status('provisioning'), status('starting'), status('working')]
    const r = await runPlaybook(ctx, pb('web_research'), { goal: 'trending repos' }, 'p1', waitDeps)
    expect(r).toMatchObject({ ok: true, data: { status: 'done' } })
    expect(calls.map((c) => c.tool)).toEqual(['task.create', 'agent.spawn', 'agent.status', 'agent.status', 'agent.status', 'agent.prompt'])
    expect(calls[2]?.args).toEqual({ projectId: 'p1', agentRef: 'ag-1' })
    expect(sleeps).toBe(2)
  })

  test('fails only after the bound, with a clear message the user is told', async () => {
    script['agent.spawn'] = [provisioning()]
    script['agent.status'] = Array.from({ length: 10 }, () => status('provisioning'))
    const r = await runPlaybook(ctx, pb('web_research'), { goal: 'slow agent' }, 'p1', waitDeps)
    expect(r).toMatchObject({ ok: false, code: 'agent_not_active', data: { status: 'failed', step: 'agent.prompt', message: 'agent ag-1 did not become active within 6 s (last state provisioning)' } })
    expect(calls.filter((c) => c.tool === 'agent.status')).toHaveLength(4) // 0, 2, 4, 6 s
    expect(calls.some((c) => c.tool === 'agent.prompt')).toBe(false)
    expect(runRow()).toMatchObject({ status: 'failed', code: 'agent_not_active' })
    expect(records.at(-1)).toBe('auto.playbook_stopped "Central stopped web research (agent ag-1 did not become active within 6 s (last state provisioning)): slow agent"')
  })

  test('an agent that ended stops the wait at once', async () => {
    script['agent.spawn'] = [provisioning()]
    script['agent.status'] = [status('failed', T0)]
    const r = await runPlaybook(ctx, pb('code_change'), { goal: 'x' }, 'p1', waitDeps)
    expect(r).toMatchObject({ ok: false, code: 'agent_not_active', data: { message: 'agent ag-1 ended (failed) before it got its brief' } })
    expect(sleeps).toBe(0)
  })
})
