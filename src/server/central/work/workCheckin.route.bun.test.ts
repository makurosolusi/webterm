// Root lock for check-in routing: a turn lands where the work was asked for, or in a stated fallback, never in an unrelated chat.
import { describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { appendCentralNotice } from '../chat/conversationNotice'
import { getOrCreateConversation } from '../conversationStore'
import { freshDb, T0 } from '../guard/controlGuard.testutil'
import { addReminder } from './workReminders'
import { CHECKIN_WINDOW_MS, createWorkCheckin, type CheckinSettingsPort, type CheckinTurn } from './workCheckin'
import { createWorkStore, onWorkMove } from './workStore'

const CENTRAL = { kind: 'central' } as const
const SYSTEM = { kind: 'system' } as const
const GLOBAL = 'central:global'
const CHAT = 'central:chat:abc'
const GONE = 'central:chat:gone'
const P1 = 'central:project:p1'

function rig() {
  const db: Database = freshDb()
  const clock = { t: T0 }
  const now = () => clock.t
  const store = createWorkStore(db, now)
  const settings: CheckinSettingsPort = { read: async () => ({ enabled: true, dailyLimit: 50 }), write: async () => {} }
  const turns: CheckinTurn[] = []
  const submit = (turn: CheckinTurn): string => { turns.push(turn); return `turn-${turns.length}` }
  const notice = (key: string, text: string, conversationId: string) => appendCentralNotice(db, { key, text, conversationId, kind: 'mock', now })
  const checkin = createWorkCheckin({ db, store, now, settings, submit, notice, env: {} })
  onWorkMove(db, checkin.onMove)
  return { db, clock, store, turns, checkin }
}
type Rig = ReturnType<typeof rig>

let seq = 0
/** A stalled task of `projectId` that was asked for in `origin` (null = no known origin). */
function stalled(r: Rig, origin: string | null, projectId = 'p1') {
  seq += 1
  const t = r.store.createTask({ id: `rt${seq}`, projectId, title: `route ${seq}`, objective: 'o', actor: CENTRAL, conversationId: origin })
  // No attempt at all: the stall rides the 5-minute window instead of waking at once (an attempt always wakes at once).
  r.db.query("UPDATE central_task SET status = 'assigned' WHERE id = ?").run(t.id)
  r.store.moveTask(t.id, 'running', { actor: SYSTEM })
  r.store.moveTask(t.id, 'stalled', { actor: SYSTEM, rule: 'stalled', reason: 'quiet' })
  return t
}
const settle = async (r: Rig) => { r.clock.t += CHECKIN_WINDOW_MS; await r.checkin.tick() }
const landed = (r: Rig) => r.turns.map((t) => t.conversationId)
const orphanNotices = (r: Rig, conversationId: string): number =>
  (r.db.query("SELECT COUNT(*) AS n FROM central_message WHERE conversation_id = ? AND role = 'system' AND parts_json LIKE '%no longer exists%'").get(conversationId) as { n: number }).n
const unsent = (r: Rig): number => (r.db.query('SELECT COUNT(*) AS n FROM central_checkin_reason WHERE sent_at IS NULL').get() as { n: number }).n

describe('check-in routing', () => {
  it('a question asked in global comes back to global even though the project has its own chat', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'project:p1')
    stalled(r, GLOBAL)
    await settle(r)
    expect(landed(r)).toEqual([GLOBAL])
    expect(orphanNotices(r, GLOBAL)).toBe(0)
  })

  it('a live origin chat gets the turn; no origin falls to the project chat, then global, with no notice', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'chat:abc')
    stalled(r, CHAT)
    await settle(r)
    getOrCreateConversation(r.db, 'project:p1')
    stalled(r, null)
    await settle(r)
    expect(landed(r)).toEqual([CHAT, P1])
    const r2 = rig()
    stalled(r2, null)
    await settle(r2)
    expect(landed(r2)).toEqual([GLOBAL])
    expect(orphanNotices(r2, GLOBAL)).toBe(0)
  })

  it('a vanished origin falls back to the project chat, else global, and always leaves a notice there', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'project:p1')
    stalled(r, GONE)
    await settle(r)
    expect(landed(r)).toEqual([P1])
    expect(orphanNotices(r, P1)).toBe(1)
    const r2 = rig()
    stalled(r2, GONE)
    await settle(r2)
    expect(landed(r2)).toEqual([GLOBAL])
    expect(orphanNotices(r2, GLOBAL)).toBe(1)
  })

  it('a batch with different origins is split: one turn per destination, none dropped to an unrelated chat', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'chat:abc')
    getOrCreateConversation(r.db, 'project:p1')
    const a = stalled(r, CHAT); const b = stalled(r, GLOBAL); const c = stalled(r, GONE, 'p2')
    await settle(r)
    expect(landed(r).sort()).toEqual([CHAT, GLOBAL].sort())
    const textOf = (id: string) => r.turns.find((t) => t.text.includes(id))?.conversationId
    expect([textOf(a.id), textOf(b.id), textOf(c.id)]).toEqual([CHAT, GLOBAL, GLOBAL])
    expect(r.turns.every((t) => t.conversationId !== P1)).toBe(true)
    expect(unsent(r)).toBe(0)
  })

  it('a busy destination holds only its own reasons; the others go and the held ones follow later', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'chat:abc')
    stalled(r, CHAT); stalled(r, GLOBAL)
    r.db.exec(`UPDATE central_conversation SET active_turn_id = 'busy' WHERE id = '${CHAT}'`)
    await settle(r)
    expect(landed(r)).toEqual([GLOBAL])
    expect(unsent(r)).toBe(1)
    r.db.exec(`UPDATE central_conversation SET active_turn_id = NULL WHERE id = '${CHAT}'`)
    await r.checkin.tick()
    expect(landed(r)).toEqual([GLOBAL, CHAT])
    expect(unsent(r)).toBe(0)
  })

  it('a due reminder returns to the conversation it was set in', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'chat:abc')
    addReminder(r.db, { projectId: null, taskId: null, text: 'look at the deploy', dueAt: T0 + 1, createdBy: 'c', conversationId: CHAT, now: T0 })
    r.clock.t = T0 + 1
    await r.checkin.tick()
    expect(landed(r)).toEqual([CHAT])
  })

  it('end to end: asked in global, delegated, the worker stops -> the wake lands in global', async () => {
    const r = rig()
    getOrCreateConversation(r.db, 'project:p1')
    const t = r.store.createTask({ id: 'e2e', projectId: 'p1', title: 'ask', objective: 'o', actor: CENTRAL, conversationId: GLOBAL })
    r.store.openAssignment({ taskId: t.id, nodeId: 'n-e2e', channel: 'spawn', instruction: 'go', actor: CENTRAL, agentId: 'a1', conversationId: GLOBAL })
    r.store.moveTask(t.id, 'running', { actor: SYSTEM })
    r.store.moveTask(t.id, 'reported', { actor: SYSTEM, rule: 'agent_report', reason: 'worker stopped' })
    await r.checkin.tick()
    expect(landed(r)).toEqual([GLOBAL])
    expect(r.turns[0]?.text).toContain(t.id)
  })
})
