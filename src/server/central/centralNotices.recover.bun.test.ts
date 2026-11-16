// The recovery sweep's `stalled` hop (rule `recover`) is never announced, even to an away user; real stalls still are.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresenceTracker } from '../channels/channelPresence'
import type { WorkerSessionPort } from '../orchestrator/workerRuntimeSession'
import { rows } from './guard/controlGuard.testutil'
import { RECOVER_RULE } from './work/workRecover.model'
import { rig } from './work/workRig.testutil'
import { createWorkTracking } from './work/workTracking'

const sessions = { isLive: () => true, input: () => {} } as unknown as WorkerSessionPort // test-only
const AWAY_MS = 4 * 60_000
const RUNTIME_ENV = 'WEBTERM_CENTRAL_RUNTIME'
const SYSTEM = { actor: { kind: 'system' } } as const

let dir = ''
const saved = { data: process.env.WEBTERM_DATA_DIR, runtime: process.env[RUNTIME_ENV] }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'work-notice-recover-'))
  process.env.WEBTERM_DATA_DIR = dir // test-only: never touch the real data dir
  process.env[RUNTIME_ENV] = 'mock' // test-only
})
afterEach(() => {
  if (saved.data === undefined) delete process.env.WEBTERM_DATA_DIR
  else process.env.WEBTERM_DATA_DIR = saved.data
  if (saved.runtime === undefined) delete process.env[RUNTIME_ENV]
  else process.env[RUNTIME_ENV] = saved.runtime
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const r = rig()
  const presence = createPresenceTracker(r.now)
  createWorkTracking({ db: r.db, sessions, now: r.now, noTimer: true, presence })
  r.clock.t += AWAY_MS
  const notices = (): string[] => rows(r.db, "SELECT parts_json FROM central_message WHERE role = 'system' ORDER BY seq").map((row) => (JSON.parse(String(row.parts_json)) as { text: string }[])[0]?.text ?? '')
  return { ...r, notices }
}

test('a recover-rule stalled hop makes no notice while away; a real stall does', () => {
  const s = setup()
  const { taskId } = s.assigned('running')
  s.store.moveTask(taskId, 'stalled', { ...SYSTEM, rule: RECOVER_RULE, reason: 'session replaced' })
  expect(s.notices()).toEqual([])
  s.store.moveTask(taskId, 'running', SYSTEM)
  s.store.moveTask(taskId, 'stalled', { ...SYSTEM, rule: 'liveness', reason: 'no signal' })
  expect(s.notices()).toEqual([`Task "title ${taskId}" in One has stalled.`])
})
