// Bun-only (real ledger schema): every automatic action leaves a Central notice and an `auto.<name>` record, the
// auto-done Undo reopens (and refuses when too late), the existing-project offer is shown once, the boot batch is one
// notice then none, and the classifier switch survives event pruning. Temp HOME / data dir / Claude dir: db.ts and
// the Claude config must never touch the user's real files. No real Claude: the classifier is a fake.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'auto-action-')) // test-only
process.env.HOME = root
process.env.WEBTERM_DATA_DIR = join(root, 'data')
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.WEBTERM_CENTRAL_RUNTIME = 'mock' // test-only: notices publish on the mock runtime's stream hub

const { freshDb, rows, run, T0 } = await import('./guard/controlGuard.testutil')
const { setActiveLedgerRuntime } = await import('../ledger/ledgerRuntimeState')
const { resetEventsRuntimeForTest } = await import('../events/eventsRuntime')
const { automaticAction } = await import('./automaticAction')
const { createWorkStore, onWorkMove } = await import('./work/workStore')
const { finishTask } = await import('./work/workLifecycle')
const { announceAutoDoneMove } = await import('./work/workTracking')
const { workDispatch } = await import('./ca2Routes.work')
const { announceAutoDone } = await import('./work/workAutoDoneOffer')
const { readAutoDone } = await import('./work/workSettings')
const { flushBootChanges, queueBootChange, resetBootChangesForTest } = await import('../bootChanges')
const { classifierSwitch, setClassifierSwitch } = await import('../policy/policy.classifier')
const { classifyCard } = await import('../policy/policy.classifier.card')
const { approvalDigest, requestApproval } = await import('../ledger/ledgerApproval')
const { syncDismissalMemory } = await import('./health/healthMemory')
const { openLedgerDb } = await import('../ledger/migration')
const { recordEvent } = await import('../events/producers')
type Db = ReturnType<typeof freshDb>

let db: Db
let clock = T0
const now = (): number => clock
beforeEach(() => {
  clock = T0
  db = freshDb()
  resetEventsRuntimeForTest()
  setActiveLedgerRuntime({ db } as never)
})
afterEach(() => { resetEventsRuntimeForTest(); setActiveLedgerRuntime(null); resetBootChangesForTest() })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const notices = (): string[] => rows(db, "SELECT parts_json FROM central_message WHERE role = 'system' ORDER BY seq").map((r) => (JSON.parse(String(r.parts_json)) as { text: string }[])[0]?.text ?? '')
const records = (kind: string): Record<string, unknown>[] => rows(db, 'SELECT payload_json FROM event WHERE kind = ? ORDER BY seq', kind).map((r) => JSON.parse(String(r.payload_json)) as Record<string, unknown>)
const HUMAN = 'human:ui'
const call = (method: string, path: string, body: unknown = {}) =>
  workDispatch({ db, now } as never, { method, path, query: new URLSearchParams(), body: async () => body }, HUMAN)

test('helper: one notice and one auto.<name> record with the contract payload; a repeated key adds neither', () => {
  const undo = { label: 'Undo', method: 'POST' as const, path: '/api/x/undo' }
  expect(automaticAction({ db, now }, { name: 'demo', actor: 'system:test', subject: 's1', text: 'Did a thing   because token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz.', undo })).toBe(true)
  expect(automaticAction({ db, now }, { name: 'demo', actor: 'system:test', subject: 's1', text: 'again' })).toBe(false)
  expect(automaticAction({ db, now }, { name: 'quiet', actor: 'system:test', text: 'Recorded only.', noNotice: true })).toBe(true)
  expect(notices()).toHaveLength(1)
  const [rec] = records('auto.demo')
  expect(rec?.undo).toEqual(undo)
  expect(String(rec?.text)).not.toContain('sk-ant-api03')
  expect(rows(db, "SELECT source FROM event WHERE kind = 'auto.demo'")[0]?.source).toBe('auto')
  expect(records('auto.quiet')).toEqual([{ text: 'Recorded only.' }])
})

function doneTask(id: string, auto: boolean) {
  const store = createWorkStore(db, now)
  store.createTask({ id, projectId: 'p1', title: `Task ${id}`, objective: 'o', actor: { kind: 'central' } })
  run(db, "UPDATE central_task SET status = 'needs_review' WHERE id = ?", id)
  finishTask(store, id, 'done', auto ? { actor: { kind: 'system', autoDone: true }, rule: 'auto_done' } : { actor: { kind: 'human', id: 'ui' } })
  return store
}

test('auto-done: notice + auto.auto_done record with Reopen; Undo reopens, is idempotent, and retires the memory fact', async () => {
  onWorkMove(db, (m) => announceAutoDoneMove(db, m, now))
  run(db, `INSERT INTO memory (id, project_id, scope, key, title, body, status, kind, trust, source_kind, source_ref, content_hash, created_at, updated_at)
    VALUES ('m1', 'p1', 'project', 'work.task.t1.outcome', 'T', 'B', 'fact', 'episode', 'attested', 'central_task', 't1', 'h', 1, 1)`)
  const store = doneTask('t1', true)
  expect(notices()).toEqual(['Marked "Task t1" done automatically: its check passed.'])
  const [rec] = records('auto.auto_done')
  expect(rec?.undo).toEqual({ label: 'Reopen', method: 'POST', path: '/api/central/tasks/t1/reopen' })
  const first = await call('POST', '/api/central/tasks/t1/reopen')
  expect(first.status).toBe(200)
  expect(store.getTask('t1')?.status).toBe('todo')
  expect(rows(db, "SELECT status FROM memory WHERE id = 'm1'")[0]?.status).toBe('superseded')
  expect((await call('POST', '/api/central/tasks/t1/reopen')).status).toBe(200) // idempotent
})

test('auto-done Undo is refused when too late or when a person closed the task', async () => {
  doneTask('h1', false)
  const human = await call('POST', '/api/central/tasks/h1/reopen')
  expect(human.status).toBe(409)
  expect(human.body).toMatchObject({ error: 'not_auto_done' })
  const store = doneTask('a1', true)
  store.createTask({ id: 'dep', projectId: 'p1', title: 'Dep', objective: 'o', actor: { kind: 'central' } })
  run(db, "INSERT INTO central_task_dep (task_id, blocked_by_id) VALUES ('dep', 'a1')")
  run(db, "UPDATE central_task SET status = 'running' WHERE id = 'dep'")
  const late = await call('POST', '/api/central/tasks/a1/reopen')
  expect(late.status).toBe(409)
  expect(late.body).toMatchObject({ error: 'too_late' })
  expect(String((late.body as { message: string }).message)).toContain('Too late')
  expect(store.getTask('a1')?.status).toBe('done')
})

test('existing project with auto-done off: one offer whose action enables it; never offered again', async () => {
  run(db, "UPDATE project SET work_auto_done = 1 WHERE id = 'p2'")
  expect(announceAutoDone(db, now)).toBe(2)
  expect(announceAutoDone(db, now)).toBe(0)
  expect(notices()).toEqual([
    'Auto-done is available for One: finished tasks whose check passes close themselves.',
    'Auto-done is on for Two: finished tasks whose check passes close themselves. Turn it off in the task board settings.',
  ])
  const [offer] = records('auto.auto_done_offer')
  expect(offer?.undo).toEqual({ label: 'Turn on', method: 'POST', path: '/api/central/work-settings', body: { projectId: 'p1', autoDone: true } })
  expect(records('auto.auto_done_default')).toHaveLength(1)
  const undo = offer?.undo as { path: string; body: unknown }
  expect((await call('POST', undo.path, undo.body)).status).toBe(200)
  expect(readAutoDone(db, 'p1')).toBe(true)
  expect(records('work.auto_done_set')).toEqual([{ projectId: 'p1', autoDone: true }])
  run(db, "INSERT INTO project (id, workspace_id, name, path, created_at, updated_at) VALUES ('p3','w3','Three','/tmp/p3',2,2)")
  expect(announceAutoDone(db, now)).toBe(1) // a project created later is announced on the next pass
})

test('boot batch: one notice per boot, then none when the next boot changes nothing new', () => {
  queueBootChange('default_on', ['WEBTERM_A', 'WEBTERM_B'])
  queueBootChange('linked', ['WEBTERM_C'])
  queueBootChange('setup', [])
  expect(flushBootChanges(db, now)).toBe(true)
  expect(notices()).toHaveLength(1)
  expect(notices()[0]).toContain('WEBTERM_A, WEBTERM_B')
  clock += 1000
  queueBootChange('default_on', ['WEBTERM_A', 'WEBTERM_B']) // same defaults applied again on the next boot
  expect(flushBootChanges(db, now)).toBe(false)
  expect(notices()).toHaveLength(1)
  expect(records('auto.boot_changes')).toHaveLength(1)
})

test('the classifier switch survives pruning of its event row', () => {
  const file = join(root, 'switch.db')
  const first = openLedgerDb(file)
  setClassifierSwitch(first, recordEvent, { central: true, permissions: true })
  first.exec("DELETE FROM event WHERE kind = 'policy.classifier_switch'") // what retention does after 30 days
  first.close()
  const reopened = openLedgerDb(file) // cache-cold read
  expect(classifierSwitch(reopened)).toEqual({ central: true, permissions: true })
  reopened.close()
})

test('classifier auto-approval posts its notice directly (the inbox row is already resolved) and records it', async () => {
  const input = { url: 'https://docs.example.com' }
  requestApproval({ db, now }, { id: 'ap1', projectId: 'p1', kind: 'browser_act', request: { tool: 'browser_act', input, inputDigest: approvalDigest(input) } })
  const outcome = await classifyCard({ db, now, classifier: async () => ({ decision: 'allow', reason: 'routine docs page' }) },
    { principal: 'central', capability: 'browser_act', tier: 'R2', args: input, approvalId: 'ap1', projectId: 'p1' })
  expect(outcome.effect).toBe('allow')
  expect(notices()).toEqual(['Approved browser_act automatically: the classifier judged it safe (routine docs page).'])
  expect(records('auto.classifier_approved')).toHaveLength(1)
})

test('health dismissal memory: notice + record with Forget', () => {
  const f = { id: 'f1', projectId: 'p1', title: 'Big file', rule: 'file_size', file: 'a.ts', line: null, status: 'dismissed', dismissedReason: 'generated', dismissedBy: 'human' } as never
  syncDismissalMemory(db, f, now())
  expect(notices()).toEqual(['Central remembered that you dismissed "Big file", so it will not raise it again.'])
  const [rec] = records('auto.memory_health_dismissal')
  expect((rec?.undo as { path: string }).path).toMatch(/^\/api\/central\/memory\/[^/]+\/forget$/)
})

test('supervisor nudge and respawn are announced with their own kinds', async () => {
  const { fakePorts } = await import('./work/workRig.testutil')
  const { createWorkSupervisor, WORK_LIVENESS_RULES } = await import('./work/workSupervisor')
  const store = createWorkStore(db, now)
  const seen: string[] = []
  const fake = fakePorts()
  const sup = createWorkSupervisor({ store, ports: fake.ports, now, announce: (a) => { seen.push(a.name); automaticAction({ db, now }, { name: a.name, text: a.text, noticeKey: a.key, actor: 'system:work' }) } })
  store.createTask({ id: 'n1', projectId: 'p1', title: 'Quiet one', objective: 'o', actor: { kind: 'central' } })
  store.openAssignment({ taskId: 'n1', nodeId: 'node-a', channel: 'terminal', instruction: 'go', actor: { kind: 'central' } })
  run(db, "UPDATE central_task SET status = 'running' WHERE id = 'n1'")
  await sup.tick(T0 + WORK_LIVENESS_RULES.heartbeat.afterMs)
  store.createTask({ id: 'r1', projectId: 'p1', title: 'Chat one', objective: 'o', actor: { kind: 'central' } })
  store.openAssignment({ taskId: 'r1', nodeId: 'node-b', channel: 'chat', instruction: 'go', actor: { kind: 'central' } })
  run(db, "UPDATE central_task SET status = 'running' WHERE id = 'r1'")
  fake.state.chatGone = true
  await sup.tick(T0 + 1000)
  expect(seen.sort()).toEqual(['work_nudge', 'work_respawn'])
  expect(records('auto.work_nudge')).toHaveLength(1)
  expect(records('auto.work_respawn')).toHaveLength(1)
  expect(notices().some((t) => t.startsWith('Nudged the agent on "Quiet one" automatically'))).toBe(true)
})

test('a self-started autonomy run is announced before it runs', async () => {
  const { startCentralAutonomyBoot } = await import('../centralAutonomyBoot')
  const env = { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: 'on', WEBTERM_CENTRAL_AUTONOMY: 'on' }
  const c = startCentralAutonomyBoot({
    runtime: { db, ledger: { event: { appendEvent: () => undefined } } } as never, env, log: () => undefined, warn: () => undefined,
    overrides: { projects: () => [{ id: 'p1', status: 'active' }], plan: () => ({ status: 'active', version: 1, items: [{ id: 'i1', seq: 1, status: 'assigned' }] }), run: async () => ({ ok: true }) },
  })
  try {
    await c.tick()
    await c.drain?.()
  } finally { c.stop(); c.dispose() }
  expect(notices()).toEqual(['Central started a worker on its own for "i1": it is the next item in the project\'s plan.'])
  expect(records('auto.autonomy_run')).toHaveLength(1)
})

test('retention sweep: one notice per day naming what was removed; nothing removed = nothing posted', async () => {
  const { announceRetentionSweep } = await import('./retentionNotice')
  announceRetentionSweep({}, now, db)
  announceRetentionSweep({ central_message: 120, central_skill: 3 }, now, db)
  clock += 3_600_000
  announceRetentionSweep({ event: 7 }, now, db) // same day: recorded, no second notice
  expect(notices()).toEqual(['Cleaned up old records: 120 chat messages and notices, 3 skill proposals. They were past their keep period.'])
  expect(records('auto.retention_sweep').map((r) => r.text)).toEqual([
    'Cleaned up old records: 120 chat messages and notices, 3 skill proposals. They were past their keep period.',
    'Cleaned up old records: 7 audit entries. They were past their keep period.',
  ])
})
