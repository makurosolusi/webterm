import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeRef, setIncognito } from '../../memory/memoryControls'
import { buildMemoryBlock } from '../../memory/memoryBlock'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import { rows } from '../guard/controlGuard.testutil'
import type { WorkMove } from './workModel'
import { rememberTaskOutcome, registerWorkMemory } from './workMemory'
import { NODE, T0, rig } from './workRig.testutil'
import { createWorkTracking } from './workTracking'

const HUMAN = { kind: 'human' } as const
const RUNTIME_ENV = 'WEBTERM_CENTRAL_RUNTIME'
const AUTHORITY = { kind: 'human', id: 'ui' } as const

let dir = ''
const saved = { data: process.env.WEBTERM_DATA_DIR, runtime: process.env[RUNTIME_ENV] }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'work-memory-'))
  process.env.WEBTERM_DATA_DIR = dir // test-only: never touch the real data dir
  process.env[RUNTIME_ENV] = 'mock' // test-only
})
afterEach(() => {
  for (const [name, value] of [['WEBTERM_DATA_DIR', saved.data], [RUNTIME_ENV, saved.runtime]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const r = rig()
  registerWorkMemory(r.db, r.now)
  return { ...r, memories: () => rows(r.db, 'SELECT * FROM memory ORDER BY created_at, id') }
}
const memoryReq = (conversationId: string, query: string) => ({ conversationId, projectId: null, query, maxTokens: 500 })

test('done writes one project fact traced to the task and its event', () => {
  const s = setup()
  const { taskId } = s.assigned('needs_review')
  s.store.moveTask(taskId, 'done', { actor: HUMAN, reason: 'looks right' })
  const mems = s.memories()
  expect(mems).toHaveLength(1)
  expect(mems[0]).toMatchObject({
    scope: 'project', project_id: 'p1', status: 'fact', trust: 'attested', kind: 'episode', source_kind: 'central_task', source_ref: taskId,
    body: `title ${taskId}: looks right`, key: `work.task.${taskId}.outcome`, verified_at: T0,
  })
  const doneSeq = s.store.timeline(taskId).find((e) => e.to === 'done')?.seq
  expect(mems[0]?.source_event_id).toBe(doneSeq)
  expect(rows(s.db, 'SELECT actor, kind FROM memory_event WHERE memory_id = ?', mems[0]?.id)).toEqual([{ actor: 'system:work', kind: 'memory.task_outcome' }])
  const now = () => T0
  expect(buildMemoryBlock(s.db, memoryReq('central:project:p1', 'title looks right'), { now }).text).toContain('[fact, project/episode]')
  expect(buildMemoryBlock(s.db, memoryReq('central:project:p2', 'title looks right'), { now }).text).toBe('')
})

test('the verifier summary is the result when it passed; other moves write nothing', () => {
  const s = setup()
  const { taskId } = s.assigned('needs_review')
  s.store.moveTask(taskId, 'running', { actor: { kind: 'system' } })
  s.store.moveTask(taskId, 'cancelled', { actor: { kind: 'system' } })
  expect(s.memories()).toHaveLength(0)
  const next = s.assigned('needs_review', { nodeId: 'n2' })
  s.store.setVerification(next.taskId, { passed: true, summary: 'all\nchecks green' })
  s.store.moveTask(next.taskId, 'done', { actor: { kind: 'system', autoDone: true }, reason: 'ignored' })
  expect(s.memories()[0]?.body).toBe(`title ${next.taskId}: all checks green`)
})

test('a failed verification that a human accepts uses the human reason, not the summary', () => {
  const s = setup()
  const { taskId } = s.assigned('needs_review')
  s.store.setVerification(taskId, { passed: false, summary: 'lint failed' })
  s.store.moveTask(taskId, 'done', { actor: HUMAN, reason: 'lint is known broken' })
  expect(s.memories()[0]?.body).toBe(`title ${taskId}: lint is known broken`)
})

test('the same move twice stores one memory', () => {
  const s = setup()
  const { taskId } = s.assigned('needs_review')
  const task = s.store.moveTask(taskId, 'done', { actor: HUMAN })
  const move: WorkMove = { task, from: 'needs_review', to: 'done', rule: null, reason: null, channel: null, seq: 1 }
  rememberTaskOutcome(s.db, move, T0)
  rememberTaskOutcome(s.db, move, T0)
  expect(s.memories()).toHaveLength(1)
  expect(s.memories()[0]?.body).toBe(`title ${taskId}: completed`)
})

test('an incognito conversation or node writes nothing and the task still finishes', () => {
  const s = setup()
  const viaConversation = s.store.createTask({ id: 'tc', projectId: 'p1', title: 'private', objective: 'o', actor: { kind: 'central' }, conversationId: 'central:project:p1' })
  setIncognito(s.db, AUTHORITY, 'central:project:p1', true, T0)
  s.db.query("UPDATE central_task SET status = 'needs_review' WHERE id = ?").run(viaConversation.id)
  expect(s.store.moveTask(viaConversation.id, 'done', { actor: HUMAN }).status).toBe('done')
  const { taskId } = s.assigned('needs_review')
  setIncognito(s.db, AUTHORITY, nodeRef(NODE), true, T0)
  expect(s.store.moveTask(taskId, 'done', { actor: HUMAN }).status).toBe('done')
  expect(s.memories()).toHaveLength(0)
})

test('PII is masked and credentials are redacted before storing', () => {
  const s = setup()
  const created = s.store.createTask({ id: 'tp', projectId: 'p1', title: 'mail admin@example.com', objective: 'o', actor: { kind: 'central' } })
  s.db.query("UPDATE central_task SET status = 'needs_review' WHERE id = ?").run(created.id)
  s.store.moveTask(created.id, 'done', { actor: HUMAN, reason: 'used sk-CANARY0123456789abcdefghij' })
  const stored = JSON.stringify(s.memories()[0])
  expect(stored).toContain('[email]')
  expect(stored).not.toContain('admin@example.com')
  expect(stored).not.toContain('CANARY')
})

test('a failing memory write does not break the move', () => {
  const s = setup()
  const { taskId } = s.assigned('needs_review')
  s.db.exec('DROP TABLE memory')
  expect(s.store.moveTask(taskId, 'done', { actor: HUMAN }).status).toBe('done')
  expect(s.statusOf(taskId)).toBe('done')
})

test('createWorkTracking wires the observer', () => {
  const r = rig()
  createWorkTracking({ db: r.db, sessions: { isLive: () => true, input: () => {} } as unknown as WorkerSessionPort, now: r.now, noTimer: true }) // test-only
  const { taskId } = r.assigned('needs_review')
  r.store.moveTask(taskId, 'done', { actor: HUMAN })
  expect(rows(r.db, 'SELECT source_ref FROM memory')).toEqual([{ source_ref: taskId }])
})
