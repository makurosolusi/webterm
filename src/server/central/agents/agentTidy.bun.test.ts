// Bun-only (real ledger schema, fake clock/canvas/host/presence). Locks the tidy's root rules: only Central's own
// finished-and-delivered workers are ever touched (park, then close); any doubt means no action; one notice per sweep.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'agent-tidy-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.WEBTERM_CENTRAL_RUNTIME = 'mock' // test-only: notices publish on the mock runtime's stream hub

const { freshDb, rows, run, T0 } = await import('../guard/controlGuard.testutil')
const { setActiveLedgerRuntime } = await import('../../ledger/ledgerRuntimeState')
const { resetEventsRuntimeForTest } = await import('../../events/eventsRuntime')
const { createEventBus } = await import('../../events/eventBus')
const { createAgentExecutor } = await import('./agentExecutor')
const { CLOSE_AFTER_MS, IDLE_GRACE_MS, MAX_IDLE_PER_PROJECT, PARK_AFTER_MS, UNPARK_PATH, createAgentTidy } = await import('./agentTidy')
const { createWorkStore } = await import('../work/workStore')
const { putTaskInStatus } = await import('../work/workRig.testutil')
const { tidyDispatch } = await import('../ca2Routes.tidy')
type Db = ReturnType<typeof freshDb>
type WorkStatus = Parameters<typeof putTaskInStatus>[2]

interface Node { id: string; kind: string; agentId?: string; collapsed?: boolean; hideLinks?: boolean }
let db: Db
let clock = T0
const now = (): number => clock
beforeEach(() => { clock = T0; db = freshDb(); resetEventsRuntimeForTest(); setActiveLedgerRuntime({ db } as never) })
afterEach(() => { resetEventsRuntimeForTest(); setActiveLedgerRuntime(null) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const notices = (): string[] => rows(db, "SELECT parts_json FROM central_message WHERE role = 'system' ORDER BY seq").map((r) => (JSON.parse(String(r.parts_json)) as { text: string }[])[0]?.text ?? '')
const tidyEvents = (): Record<string, unknown>[] => rows(db, "SELECT payload_json FROM event WHERE kind = 'central.tidy' ORDER BY seq").map((r) => JSON.parse(String(r.payload_json)) as Record<string, unknown>)
const stateOf = (id: string): string => String(rows(db, 'SELECT state FROM central_agents WHERE id = ?', id)[0]?.state)

function setup() {
  const flags = { enabled: true, impaired: false, focus: null as string | null, leased: new Set<string>() }
  const board = { id: 'w1', nodes: [] as Node[], bridges: [] as { id: string; source: string; target: string }[] }
  const calls = { update: 0, remove: 0 }
  const closed: string[] = []
  const canvas = {
    workspaceOfNode: (id: string) => (board.nodes.some((n) => n.id === id) ? board : null),
    update: ({ patches }: { patches: Array<Node & { collapsed?: boolean | null; hideLinks?: boolean | null }> }) => {
      calls.update++
      for (const p of patches) {
        const n = board.nodes.find((x) => x.id === p.id)
        if (!n) continue
        for (const k of ['collapsed', 'hideLinks'] as const) if (p[k] === null) delete n[k]; else if (p[k] !== undefined) n[k] = p[k] as boolean
      }
      return { ok: true as const }
    },
    remove: ({ nodeIds }: { nodeIds: string[] }) => {
      calls.remove++
      board.nodes = board.nodes.filter((n) => !nodeIds.includes(n.id))
      board.bridges = board.bridges.filter((b) => !nodeIds.includes(b.source) && !nodeIds.includes(b.target))
      return { ok: true as const }
    },
  }
  const guard = { check: () => ({ verdict: 'allow' as const, level: 'act_gated' as const }), effectiveLevel: () => 'act_gated' as const, recordUsage: () => undefined, skipsApprovals: () => false,
    breaker: { allow: () => ({ allowed: true, state: 'closed' as const }), trip: () => 'closed' as const, recordSuccess: () => undefined } }
  const host = {
    runnerFor: () => 'pty' as const, spawnTier: () => 'R2' as const, worktree: async () => '/tmp/wt', initialPrompt: async () => 'go', openPty: async () => undefined, headlessArgv: () => null,
    send: async () => ({ ok: true as const, started: true as const }), scrollback: async () => [], closePty: async (n: string) => { closed.push(n) }, hasSession: () => true,
  }
  const ex = createAgentExecutor({ db, guard, host, now })
  const bus = createEventBus()
  const records: unknown[] = []
  const tidy = createAgentTidy({
    db, now, executor: () => ex, canvas: () => canvas as never, focused: () => (flags.focus ? { nodeId: flags.focus } : null), bus,
    enabled: () => flags.enabled, impaired: () => flags.impaired, browserLease: (id) => (flags.leased.has(id) ? 'agent' : 'human'),
    notify: { record: (e) => { records.push(e) } },
  })
  const works = createWorkStore(db, now)
  const sent = (taskId: string, at: number | null): void => run(db, "INSERT INTO central_checkin_reason (id, dedupe_key, kind, project_id, task_id, text, created_at, sent_at) VALUES (?, ?, 'task_reported', 'p1', ?, 't', ?, ?)", `r-${taskId}`, `d-${taskId}`, taskId, T0, at)
  /** A pty agent on the board; defaults = a Central worker, finished, result delivered, task reported. */
  const agent = (id: string, o: { owner?: string; state?: string; project?: string; task?: WorkStatus; delivered?: boolean; browser?: string; endedAt?: number; assigned?: boolean } = {}): string => {
    const project = o.project ?? 'p1'
    const taskId = `t-${id}`
    works.createTask({ id: taskId, projectId: project, title: id, objective: 'o', actor: { kind: 'central' } })
    if (o.assigned) works.openAssignment({ taskId, nodeId: `n-${id}`, channel: 'terminal', instruction: 'x', actor: { kind: 'central' } })
    putTaskInStatus(works, taskId, o.task ?? 'reported')
    if (o.delivered !== false) sent(taskId, T0)
    else sent(taskId, null)
    run(db, "INSERT INTO central_agents (id, project_id, kind, runner, task_id, node_id, state, owner, started_at, last_event_at, ended_at) VALUES (?, ?, 'claude', 'pty', ?, ?, ?, ?, ?, ?, ?)",
      id, project, taskId, `n-${id}`, o.state ?? 'candidate_done', o.owner ?? 'central:global', T0, T0, o.endedAt ?? null)
    board.nodes.push({ id: `n-${id}`, kind: 'agent', agentId: 'claude' })
    if (o.browser) { board.nodes.push({ id: o.browser, kind: 'browser' }); board.bridges.push({ id: `b-${o.browser}`, source: `n-${id}`, target: o.browser }) }
    return `n-${id}`
  }
  return { flags, board, calls, closed, ex, bus, records, tidy, agent, works }
}

const nodeIds = (s: ReturnType<typeof setup>): string[] => s.board.nodes.map((n) => n.id)

test('policy: nodes and agents that are not Central workers are never touched, however old', async () => {
  const s = setup()
  s.agent('mine')
  s.agent('theirs', { owner: 'human' })
  s.board.nodes.push({ id: 'chat1', kind: 'agentChat' }, { id: 'ed1', kind: 'editor' }, { id: 'files1', kind: 'files' }, { id: 'term1', kind: 'terminal' }, { id: 'userbr', kind: 'browser' })
  s.board.bridges.push({ id: 'bx', source: 'n-mine', target: 'userbr' })
  clock = T0 + CLOSE_AFTER_MS * 3
  await s.tidy.sweep()
  clock += CLOSE_AFTER_MS * 3
  await s.tidy.sweep()
  const after = nodeIds(s)
  expect(after).toEqual(expect.arrayContaining(['n-theirs', 'chat1', 'ed1', 'files1', 'term1', 'userbr']))
  expect(after).not.toContain('n-mine')
  expect(stateOf('theirs')).toBe('candidate_done')
  expect(s.board.nodes.find((n) => n.id === 'n-theirs')?.collapsed).toBe(undefined)
  expect(tidyEvents().every((e) => e.agentId === 'mine')).toBe(true)
})

const BLOCKERS: Array<[string, (s: ReturnType<typeof setup>) => void]> = [
  ['working', (s) => { s.agent('a', { state: 'working' }) }],
  ['waiting_input', (s) => { s.agent('a', { state: 'waiting_input' }) }],
  ['approval_pending', (s) => { s.agent('a', { state: 'approval_pending' }) }],
  ['result not delivered yet', (s) => { s.agent('a', { delivered: false }) }],
  ['task still running', (s) => { s.agent('a', { task: 'running' }) }],
  ['user is looking at it', (s) => { s.flags.focus = s.agent('a') }],
  ['project paused', (s) => { s.agent('a'); run(db, "UPDATE project SET status = 'paused' WHERE id = 'p1'") }],
  ['connectivity impaired', (s) => { s.agent('a'); s.flags.impaired = true }],
  ['switch off', (s) => { s.agent('a'); s.flags.enabled = false }],
  ['open assignment on the node', (s) => { s.agent('a', { assigned: true }) }],
]
for (const [name, arrange] of BLOCKERS) {
  test(`no action: ${name}`, async () => {
    const s = setup()
    arrange(s)
    for (let i = 0; i < 3; i++) { clock += CLOSE_AFTER_MS; expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 0 }) }
    expect(s.calls).toEqual({ update: 0, remove: 0 })
    expect(s.closed).toEqual([])
    expect(tidyEvents()).toEqual([])
    expect(notices()).toEqual([])
  })
}

test('parks after PARK_AFTER, closes (agent, node, idle Central browser only) after CLOSE_AFTER', async () => {
  const s = setup()
  s.agent('a', { browser: 'br-1' })
  s.board.nodes.push({ id: 'br-leased', kind: 'browser' }, { id: 'userbr', kind: 'browser' })
  s.board.bridges.push({ id: 'b2', source: 'n-a', target: 'br-leased' }, { id: 'b3', source: 'n-a', target: 'userbr' })
  s.flags.leased.add('br-leased')
  clock = T0 + PARK_AFTER_MS - 1
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 0 })
  clock = T0 + PARK_AFTER_MS
  expect(await s.tidy.sweep()).toEqual({ parked: 1, closed: 0 })
  expect(s.board.nodes.find((n) => n.id === 'n-a')).toMatchObject({ collapsed: true, hideLinks: true })
  expect(s.board.nodes.find((n) => n.id === 'br-1')?.collapsed).toBe(true)
  expect(s.board.nodes.find((n) => n.id === 'userbr')?.collapsed).toBe(undefined)
  expect(stateOf('a')).toBe('candidate_done')
  clock += CLOSE_AFTER_MS - 1
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 0 })
  clock += 1
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 1 })
  expect(stateOf('a')).toBe('cancelled')
  expect(s.closed).toEqual(['n-a'])
  expect(nodeIds(s).sort()).toEqual(['br-leased', 'userbr'])
})

test('over MAX_IDLE_PER_PROJECT the oldest are closed once past the grace; younger ones stay', async () => {
  const s = setup()
  for (const id of ['o1', 'o2', 'o3', 'o4']) { s.agent(id); run(db, 'UPDATE central_agents SET last_event_at = ? WHERE id = ?', T0 + Number(id.slice(1)), id) }
  clock = T0 + IDLE_GRACE_MS - 10
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 0 })
  clock = T0 + IDLE_GRACE_MS + 10
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 4 - MAX_IDLE_PER_PROJECT })
  expect(['o1', 'o2'].map(stateOf)).toEqual(['cancelled', 'cancelled'])
  expect(['o3', 'o4'].map(stateOf)).toEqual(['candidate_done', 'candidate_done'])
  expect(nodeIds(s).sort()).toEqual(['n-o3', 'n-o4'])
})

test('a worker that ended long ago leaves its node on the board only until the sweep closes it', async () => {
  const s = setup()
  s.agent('gone', { state: 'session_exited', endedAt: T0 })
  s.agent('recent', { state: 'session_exited', endedAt: T0 + CLOSE_AFTER_MS })
  clock = T0 + CLOSE_AFTER_MS + 1
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 1 })
  expect(nodeIds(s)).toEqual(['n-recent'])
})

test('a parked worker that wakes is opened again at once (hook event) and the safety-net sweep also opens it', async () => {
  const s = setup()
  s.agent('a')
  s.agent('b')
  clock = T0 + PARK_AFTER_MS
  await s.tidy.sweep()
  expect(s.board.nodes.filter((n) => n.collapsed)).toHaveLength(2)
  s.ex.store.transition('a', 'working')
  s.bus.publish({ kind: 'hook.UserPromptSubmit', source: 'test', actor: 'agent', nodeId: 'n-a', trust: 'trusted', payload: {} } as never)
  expect(s.board.nodes.find((n) => n.id === 'n-a')).toEqual({ id: 'n-a', kind: 'agent', agentId: 'claude' })
  s.ex.store.transition('b', 'working')
  clock += 1000
  await s.tidy.sweep()
  expect(s.board.nodes.find((n) => n.id === 'n-b')).toEqual({ id: 'n-b', kind: 'agent', agentId: 'claude' })
  expect(tidyEvents().filter((e) => e.action === 'unpark').map((e) => e.reason)).toEqual(['woke', 'woke'])
})

test('exactly one notice per sweep, none when nothing happened; sweeping again changes nothing; Undo opens them', async () => {
  const s = setup()
  s.agent('a')
  s.agent('b')
  s.agent('c', { project: 'p2' })
  clock = T0 + PARK_AFTER_MS
  await s.tidy.sweep()
  expect(notices()).toHaveLength(1)
  expect(notices()[0]).toContain('parked 3 finished workers')
  const events = tidyEvents().length
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 0 })
  expect(notices()).toHaveLength(1)
  expect(tidyEvents()).toHaveLength(events)
  expect(s.calls.update).toBe(3)
  const record = s.records[0] as { payload: { undo: { path: string; body: { agentIds: string[] } } } }
  expect(record.payload.undo.path).toBe(UNPARK_PATH)
  const body = record.payload.undo.body
  expect(await tidyDispatch({ tidy: s.tidy } as never, { method: 'POST', body: async () => body }, 'human:ui')).toEqual({ status: 200, body: { unparked: 3 } })
  expect(await tidyDispatch({ tidy: s.tidy } as never, { method: 'POST', body: async () => body }, 'agent:x')).toMatchObject({ status: 403 })
  expect(s.board.nodes.filter((n) => n.collapsed)).toHaveLength(0)
  // Opening by hand is not "idle": the clock restarts, so the very next sweep does not park again.
  expect(await s.tidy.sweep()).toEqual({ parked: 0, closed: 0 })
})
