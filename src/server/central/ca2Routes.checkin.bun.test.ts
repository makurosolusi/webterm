import { describe, expect, it } from 'bun:test'
import type { Ca2Handle } from './ca2Boot'
import { checkinDispatch, isCheckinPath } from './ca2Routes.checkin'
import { freshDb, T0 } from './guard/controlGuard.testutil'
import type { CheckinSettingsPort } from './work/workCheckin'
import { addReminder, markReminderFired } from './work/workReminders'

const HUMAN = 'human:root'
function rig() {
  const db = freshDb()
  const conf = { enabled: true, dailyLimit: 10 }
  const settings: CheckinSettingsPort = { read: async () => ({ ...conf }), write: async (p) => { Object.assign(conf, p) } }
  const h = { db, now: () => T0 } as unknown as Ca2Handle
  const call = (method: string, path: string, body: unknown = {}, actor = HUMAN, q = '') =>
    checkinDispatch(h, { method, path, query: new URLSearchParams(q), body: async () => body }, actor, settings)
  const add = (text: string, dueAt: number, projectId: string | null = 'p1') => addReminder(db, { projectId, taskId: null, text, dueAt, createdBy: 'central', conversationId: null, now: T0 })
  return { db, conf, call, add }
}
const SETTINGS = '/api/central/checkin-settings'
const REMINDERS = '/api/central/reminders'

describe('check-in routes', () => {
  it('claims exactly its paths', () => {
    for (const p of [SETTINGS, REMINDERS, `${REMINDERS}/r1/cancel`]) expect(isCheckinPath(p)).toBe(true)
    expect(isCheckinPath(`${REMINDERS}/r1`)).toBe(false)
  })

  it('reads and writes the settings; usedToday counts system turns', async () => {
    const r = rig()
    r.db.exec(`INSERT INTO central_turn (id, conversation_id, message_id, status, started_at, origin) VALUES ('s', 'c', 'm', 'succeeded', ${T0}, 'system')`)
    expect(await r.call('GET', SETTINGS)).toEqual({ status: 200, body: { enabled: true, dailyLimit: 10, usedToday: 1 } })
    expect(await r.call('POST', SETTINGS, { enabled: false, dailyLimit: 50 })).toEqual({ status: 200, body: { enabled: false, dailyLimit: 50, usedToday: 1 } })
    expect(r.conf).toEqual({ enabled: false, dailyLimit: 50 })
  })

  it('refuses values outside the choices', async () => {
    const r = rig()
    expect((await r.call('POST', SETTINGS, { dailyLimit: 7 })).status).toBe(400)
    expect((await r.call('POST', SETTINGS, { enabled: 'yes' })).status).toBe(400)
    expect(r.conf).toEqual({ enabled: true, dailyLimit: 10 })
  })

  it('writes are human-only', async () => {
    const r = rig()
    expect(await r.call('POST', SETTINGS, { enabled: false }, 'agent:x')).toEqual({ status: 403, body: { error: 'human_only' } })
    expect((await r.call('POST', `${REMINDERS}/r/cancel`, {}, 'central')).status).toBe(403)
    expect(r.conf.enabled).toBe(true)
  })

  it('lists pending first with project names and pages', async () => {
    const r = rig()
    const fired = r.add('fired', T0 + 1)
    markReminderFired(r.db, fired.id, T0)
    r.add('later', T0 + 200, null)
    r.add('soon', T0 + 100)
    const res = await r.call('GET', REMINDERS, {}, HUMAN, 'limit=2')
    expect(res.status).toBe(200)
    const body = res.body as { items: { text: string; projectName: string | null; status: string }[]; hasMore: boolean }
    expect(body.items.map((i) => i.text)).toEqual(['soon', 'later'])
    expect(body.items[0]).toMatchObject({ projectId: 'p1', projectName: 'One', taskId: null, dueAt: T0 + 100, status: 'pending' })
    expect(body.hasMore).toBe(true)
    expect(((await r.call('GET', REMINDERS, {}, HUMAN, 'limit=2&offset=2')).body as typeof body).items.map((i) => i.status)).toEqual(['fired'])
    expect((await r.call('GET', REMINDERS, {}, HUMAN, 'limit=0')).status).toBe(400)
  })

  it('cancels a pending reminder only', async () => {
    const r = rig()
    const card = r.add('x', T0 + 1)
    expect(await r.call('POST', `${REMINDERS}/${card.id}/cancel`)).toEqual({ status: 200, body: { id: card.id, status: 'cancelled' } })
    expect((await r.call('POST', `${REMINDERS}/${card.id}/cancel`)).status).toBe(409)
    expect((await r.call('POST', `${REMINDERS}/nope/cancel`)).status).toBe(404)
    expect((await r.call('GET', `${REMINDERS}/x/cancel`)).status).toBe(405)
  })
})
