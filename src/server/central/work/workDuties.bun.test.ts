// Open duties: a delegation Central started that went wrong is listed, wakes Central after a grace period, wakes it
// once more if a check-in turn left it unresolved, and ends in a user notice; never silence, never a repeat.
import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { appendCentralNotice } from '../chat/conversationNotice'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { applyV31 } from '../../ledger/ledgerSchemaV31'
import { createWorkCheckin, type CheckinSettingsPort, type CheckinTurn } from './workCheckin'
import { beginDelegation } from './workDelegation'
import { listDuties } from './workDuties'
import { ESCALATE_EVENT } from './workEscalation'
import { createWorkStore, onWorkMove } from './workStore'
import { WORK_LIVENESS_RULES } from './workSupervisor'

const MIN = 60_000
const { graceMs, afterMs } = WORK_LIVENESS_RULES.escalate
const SYSTEM = { kind: 'system' } as const

function rig() {
  const db = freshDb()
  const clock = { t: T0 }
  const now = () => clock.t
  const store = createWorkStore(db, now)
  const conf = { enabled: true, dailyLimit: 10 }
  const settings: CheckinSettingsPort = { read: async () => conf, write: async () => {} }
  const turns: CheckinTurn[] = []
  const submit = (turn: CheckinTurn): string => { turns.push(turn); return `turn-${turns.length}` }
  const notice = (key: string, text: string, conversationId: string) => appendCentralNotice(db, { key, text, conversationId, kind: 'mock', now })
  const checkin = createWorkCheckin({ db, store, now, settings, submit, notice, env: {} })
  onWorkMove(db, checkin.onMove)
  const at = async (ms: number) => { clock.t = T0 + ms; await checkin.tick() }
  return { db, clock, store, conf, turns, checkin, at }
}
type Rig = ReturnType<typeof rig>

/** Central types a prompt into a Claude node and the submit reports `not_started` (prompt left in the box). */
function failedSend(r: Rig, nodeId = 'n1'): string {
  const d = beginDelegation(r.store, { projectId: 'p1', nodeId, channel: 'terminal', instruction: 'deploy the api', conversationId: 'central:global' })
  if (!d.ok) throw new Error(d.code)
  d.settleFailed('not_started', { textLeftInBox: true })
  return d.taskId
}
const notices = (db: Database) => (db.query("SELECT parts_json AS p FROM central_message WHERE role = 'system'").all() as { p: string }[]).map((x) => x.p)
const rungs = (r: Rig, taskId: string) => r.store.timeline(taskId).filter((e) => e.kind === ESCALATE_EVENT).map((e) => e.rule)

describe('open duties', () => {
  it('a failed send is listed with its reason and that the text is still in the box', () => {
    const r = rig()
    const id = failedSend(r)
    expect(listDuties(r.db, 5)).toEqual([{ taskId: id, projectId: 'p1', title: 'deploy the api', nodeId: 'n1', status: 'failed', reason: 'not_started', attempts: 1, since: T0, textLeftInBox: true }])
  })

  it('a task the user cancelled, or one a human started, is not a duty', () => {
    const r = rig()
    const id = failedSend(r)
    r.store.moveTask(id, 'cancelled', { actor: { kind: 'human' } })
    const mine = r.store.createTask({ projectId: 'p1', title: 'mine', objective: 'o', actor: { kind: 'human' } })
    r.store.openAssignment({ taskId: mine.id, nodeId: 'n2', channel: 'terminal', instruction: 'x', actor: { kind: 'human' } })
    r.store.moveTask(mine.id, 'failed', { actor: SYSTEM, rule: 'vanished' })
    expect(listDuties(r.db, 5)).toEqual([])
  })

  it('wakes Central only after the grace period, once', async () => {
    const r = rig()
    failedSend(r)
    await r.at(graceMs - 1)
    expect(r.turns).toHaveLength(0)
    await r.at(graceMs)
    expect(r.turns).toHaveLength(1)
    expect(r.turns[0]?.text).toContain('task_duty')
    expect(r.turns[0]?.text).toContain('not_started')
    await r.at(graceMs + 1000)
    expect(r.turns).toHaveLength(1)
  })

  it('a duty fixed in the same turn (Enter pressed and tracked again) wakes nobody', async () => {
    const r = rig()
    const id = failedSend(r)
    const again = beginDelegation(r.store, { projectId: 'p1', nodeId: 'n1', channel: 'terminal', instruction: '(resubmit)', taskId: id, conversationId: 'central:global' })
    expect(again.ok).toBe(true)
    expect(listDuties(r.db, 5)).toEqual([])
    await r.at(graceMs)
    await r.at(afterMs)
    expect(r.turns).toHaveLength(0)
    expect(notices(r.db)).toEqual([])
  })

  it('climbs the ladder: wake, one more wake after the check-in turn, then a user notice after 15 minutes; each rung once', async () => {
    const r = rig()
    const id = failedSend(r)
    await r.at(graceMs) // rung 2: the move wake
    await r.at(graceMs + 30_000) // the wake went out and the task is still failed: queued once more
    await r.at(graceMs + 5 * MIN + 30_000)
    await r.at(graceMs + 10 * MIN)
    expect(r.turns).toHaveLength(2)
    expect(r.turns[1]?.text).toContain('Open duties')
    expect(notices(r.db)).toEqual([])
    await r.at(afterMs)
    await r.at(afterMs + MIN)
    expect(r.turns).toHaveLength(2)
    expect(notices(r.db)).toHaveLength(1)
    expect(notices(r.db)[0]).toContain('Central could not fix task \\"deploy the api\\" in project One: failed (not_started; the prompt is still in its input box) for 15 min. Central was woken 2 time(s).')
    expect(rungs(r, id)).toEqual(['escalate', 'escalate'])
  })

  it('a stalled task Central delegated also ends in a user notice', async () => {
    const r = rig()
    const t = r.store.createTask({ projectId: 'p1', title: 'build', objective: 'o', actor: { kind: 'central' } })
    r.store.openAssignment({ taskId: t.id, nodeId: 'n1', channel: 'terminal', instruction: 'go', actor: { kind: 'central' } })
    r.store.moveTask(t.id, 'stalled', { actor: SYSTEM, rule: 'startup', reason: 'no signal since started' })
    await r.at(5 * MIN)
    expect(r.turns).toHaveLength(1)
    await r.at(afterMs)
    expect(notices(r.db)).toHaveLength(1)
    expect(notices(r.db)[0]).toContain('stalled (no signal since started)')
  })

  it('with check-ins off it goes straight to the user notice after the grace period', async () => {
    const r = rig()
    r.conf.enabled = false
    failedSend(r)
    await r.at(graceMs - 1)
    expect(notices(r.db)).toEqual([])
    await r.at(graceMs)
    await r.at(graceMs + MIN)
    expect(r.turns).toHaveLength(0)
    expect(notices(r.db)).toHaveLength(1)
    expect(notices(r.db)[0]).toContain('check-ins are off or used up')
  })

  it('with the daily check-in cap used it also notifies the user', async () => {
    const r = rig()
    r.conf.dailyLimit = 0
    failedSend(r)
    await r.at(graceMs)
    expect(r.turns).toHaveLength(0)
    expect(notices(r.db).filter((n) => n.includes('Central could not fix'))).toHaveLength(1)
  })

  it('v31 re-applied is a no-op', () => {
    const r = rig()
    applyV31(r.db)
    expect((r.db.query("SELECT COUNT(*) AS n FROM pragma_table_info('central_checkin_reason') WHERE name = 'not_before'").get() as { n: number }).n).toBe(1)
  })
})
