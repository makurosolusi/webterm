import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresenceTracker } from '../../channels/channelPresence'
import { eventBus } from '../../events/eventBus'
import { inTransaction, tx } from '../../ledger/ledgerCore'
import type { WorkerSessionPort } from '../../orchestrator/workerRuntimeSession'
import type { CompletionVerdict } from '../../verifier/verifier.judge'
import { setTelegramNoticeMirror } from '../centralNotices'
import { rows } from '../guard/controlGuard.testutil'
import type { WorkMove } from './workModel'
import { event, rig } from './workRig.testutil'
import { writeAutoDone } from './workSettings'
import { createWorkStore, onWorkMove } from './workStore'
import { createWorkTracking } from './workTracking'

const sessions = { isLive: () => true, input: () => {} } as unknown as WorkerSessionPort // test-only
const PASS = { status: 'done', reason: 'verified', message: 'm', summary: 'green', filesChanged: [], leaseViolations: [] } as unknown as CompletionVerdict // test-only
const AWAY_MS = 4 * 60_000
const RUNTIME_ENV = 'WEBTERM_CENTRAL_RUNTIME'
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let dir = ''
const saved = { data: process.env.WEBTERM_DATA_DIR, runtime: process.env[RUNTIME_ENV] }
let stops: (() => void)[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'work-notice-'))
  process.env.WEBTERM_DATA_DIR = dir // test-only: never touch the real data dir
  process.env[RUNTIME_ENV] = 'mock' // test-only: the notice publishes on the mock runtime's stream hub
})
afterEach(() => {
  stops.forEach((stop) => stop())
  stops = []
  if (saved.data === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = saved.data
  if (saved.runtime === undefined) delete process.env[RUNTIME_ENV]
  else process.env[RUNTIME_ENV] = saved.runtime
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const r = rig()
  const presence = createPresenceTracker(r.now)
  let finish: (v: CompletionVerdict) => void = () => {}
  const check = () => new Promise<CompletionVerdict>((resolve) => { finish = resolve })
  const tracking = createWorkTracking({ db: r.db, sessions, now: r.now, noTimer: true, check, presence })
  const away = (): void => { r.clock.t += AWAY_MS }
  const notices = (): string[] => rows(r.db, "SELECT parts_json FROM central_message WHERE role = 'system' ORDER BY seq").map((row) => (JSON.parse(String(row.parts_json)) as { text: string }[])[0]?.text ?? '')
  return { ...r, presence, tracking, away, notices, finish: (v: CompletionVerdict) => finish(v) }
}
const failure = (fn: () => unknown): string => {
  try { fn() } catch (err) { return String(err) }
  return 'no_error'
}
const SYSTEM = { actor: { kind: 'system' } } as const

test('each listed state names the task and project, once per entry', () => {
  const s = setup()
  s.away()
  const { taskId } = s.assigned('running', { channel: 'run' })
  s.store.moveTask(taskId, 'waiting_input', SYSTEM)
  s.store.moveTask(taskId, 'running', SYSTEM)
  s.store.moveTask(taskId, 'stalled', SYSTEM)
  s.store.moveTask(taskId, 'running', SYSTEM)
  s.store.moveTask(taskId, 'stalled', SYSTEM)
  s.store.moveTask(taskId, 'failed', SYSTEM)
  const other = s.assigned('reported', { nodeId: 'n2' })
  s.store.moveTask(other.taskId, 'needs_review', SYSTEM)
  expect(s.notices()).toEqual([
    `Task "title ${taskId}" in One needs your input.`,
    `Task "title ${taskId}" in One has stalled.`,
    `Task "title ${taskId}" in One has stalled.`,
    `Task "title ${taskId}" in One failed.`,
    `Task "title ${other.taskId}" in One is ready for review.`,
  ])
})

for (const [channel, count] of [['terminal', 0], ['spawn', 0], ['chat', 0], ['run', 1]] as const) {
  test(`waiting_input on a ${channel} assignment: ${count} task notice; other states still notify`, () => {
    const s = setup()
    s.away()
    const { taskId } = s.assigned('running', { channel })
    s.store.moveTask(taskId, 'waiting_input', SYSTEM)
    expect(s.notices()).toHaveLength(count)
    s.store.moveTask(taskId, 'failed', SYSTEM)
    expect(s.notices()).toHaveLength(count + 1)
  })
}

test('never for running or the other states', () => {
  const s = setup()
  s.away()
  const { taskId } = s.assigned()
  s.store.moveTask(taskId, 'running', SYSTEM)
  s.store.moveTask(taskId, 'reported', SYSTEM)
  s.store.moveTask(taskId, 'cancelled', SYSTEM)
  expect(s.notices()).toEqual([])
})

test('a store built elsewhere on the same database is observed too', () => {
  const s = setup()
  s.away()
  const { taskId } = s.assigned('running')
  createWorkStore(s.db, s.now).moveTask(taskId, 'failed', SYSTEM)
  expect(s.notices()).toHaveLength(1)
})

test('quiet while the user is at the board or the workspace is muted', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  s.store.moveTask(taskId, 'stalled', SYSTEM)
  expect(s.notices()).toEqual([])
  s.presence.note({ visible: false, muted: ['w1'] })
  s.away()
  s.store.moveTask(taskId, 'running', SYSTEM)
  s.store.moveTask(taskId, 'failed', SYSTEM)
  expect(s.notices()).toEqual([])
})

test('Telegram mirrors the same text once, only to chats bound to the project', () => {
  const s = setup()
  const sent: { key: string; chatId: string; text: string }[] = []
  const unplug = setTelegramNoticeMirror({
    forwardAwayMinutes: 1,
    listBindings: () => [{ chatId: 'c1', binding: { projectId: 'p1' } }, { chatId: 'c2', binding: { projectId: 'p2' } }] as never,
    enqueueReply: (input) => { sent.push(input as never); return {} as never },
  })
  try {
    s.away()
    const { taskId } = s.assigned('running')
    s.store.moveTask(taskId, 'failed', SYSTEM)
  } finally { unplug() }
  expect(sent.map((m) => m.chatId)).toEqual(['c1'])
  expect(sent[0]?.text).toBe(s.notices()[0])
})

test('a throwing observer neither rolls back nor breaks the move, and later observers still run', () => {
  const s = setup()
  const seen: WorkMove[] = []
  const { taskId } = s.assigned('running')
  onWorkMove(s.db, () => { throw new Error('boom') })
  onWorkMove(s.db, (m) => seen.push(m))
  const moved = s.store.moveTask(taskId, 'failed', SYSTEM)
  expect(moved.status).toBe('failed')
  expect(s.statusOf(taskId)).toBe('failed')
  expect(seen.map((m) => [m.from, m.to])).toEqual([['running', 'failed']])
})

test('observers run after commit, and a rollback tells them nothing', async () => {
  const s = setup()
  const seen: boolean[] = []
  onWorkMove(s.db, () => seen.push(inTransaction(s.db)))
  const { taskId } = s.assigned('running')
  seen.length = 0
  s.store.moveTask(taskId, 'stalled', SYSTEM)
  expect(seen).toEqual([false])
  expect(failure(() => s.store.moveTask(taskId, 'done', SYSTEM))).toContain('illegal_transition')
  expect(seen).toEqual([false])

  seen.length = 0
  tx({ db: s.db, now: s.now }, () => { s.store.moveTask(taskId, 'running', SYSTEM); expect(seen).toEqual([]) })
  await settle()
  expect(seen).toEqual([false])

  seen.length = 0
  expect(failure(() => tx({ db: s.db, now: s.now }, () => { s.store.moveTask(taskId, 'failed', SYSTEM); throw new Error('caller rolls back') }))).toContain('caller rolls back')
  await settle()
  expect(seen).toEqual([])
  expect(s.statusOf(taskId)).toBe('running')
})

test('auto-done is read per task: flipping it applies at once, and an auto-done pass is not announced', async () => {
  const s = setup()
  stops.push(s.tracking.start())
  s.away()
  const pass = async (nodeId: string) => {
    const { taskId } = s.assigned('running', { acceptance: 'project_checks', nodeId })
    eventBus.publish(event('hook.Stop', {}, nodeId))
    await settle()
    s.finish(PASS)
    await settle()
    return taskId
  }
  const off = await pass('n-off')
  expect(s.statusOf(off)).toBe('needs_review')
  expect(s.notices()).toHaveLength(1)
  writeAutoDone(s.db, 'p1', true, s.now())
  const on = await pass('n-on')
  expect(s.statusOf(on)).toBe('done')
  expect(s.lastRule(on)).toBe('auto_done')
  expect(s.notices()).toHaveLength(1)
  writeAutoDone(s.db, 'p1', false, s.now())
  expect(s.statusOf(await pass('n-back'))).toBe('needs_review')
})
