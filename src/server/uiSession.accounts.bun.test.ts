// ui_session account columns: user_id/ua, list, revokeById, revokeUser, absolute expiry, old-schema migration.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_TOUCH_MS, SESSION_UA_MAX, createUiSessionStore } from './uiSession'

const clock = () => {
  const c = { t: 1_000_000, now: () => c.t }
  return c
}

describe('ui_session accounts', () => {
  test('create binds user and ua; userOf/list report them; token-era sessions have none', () => {
    const c = clock()
    const s = createUiSessionStore(new Database(':memory:'), c.now)
    const legacy = s.create()
    c.t += 1
    const mine = s.create({ userId: 7, ua: 'U'.repeat(SESSION_UA_MAX + 50) })
    expect(s.verify(legacy)).toBe(true)
    expect(s.userOf(legacy)).toBeNull()
    expect(s.userOf(mine)).toBe(7)
    expect(s.userOf('garbage')).toBeNull()
    const list = s.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ userId: 7, createdAt: c.t, lastSeen: c.t })
    expect((list[0].ua ?? '').length).toBe(SESSION_UA_MAX)
    expect(list[1]).toMatchObject({ userId: null, ua: null })
    expect(list[0].id).toMatch(/^[0-9a-f]{12}$/)
    expect(JSON.stringify(list)).not.toContain(mine) // the cookie value never leaves
  })
  test('revokeById removes one session; junk ids are a no-op', () => {
    const s = createUiSessionStore(new Database(':memory:'))
    const a = s.create({ userId: 1 })
    const [{ id }] = s.list()
    const b = s.create({ userId: 1 })
    s.revokeById('nothex')
    s.revokeById('%')
    expect(s.count()).toBe(2)
    s.revokeById(id)
    expect([s.verify(a), s.verify(b)]).toEqual([false, true])
  })
  test('revokeUser keeps other users, token-era rows and the caller', () => {
    const s = createUiSessionStore(new Database(':memory:'))
    const me = s.create({ userId: 1 }), other = s.create({ userId: 1 }), bob = s.create({ userId: 2 }), legacy = s.create()
    s.revokeUser(1, me)
    expect([s.verify(me), s.verify(other), s.verify(bob), s.verify(legacy)]).toEqual([true, false, true, true])
    s.revokeUser(1)
    expect(s.verify(me)).toBe(false)
  })
  test('absolute expiry ends a busy session 90 days after sign-in; idle expiry unchanged', () => {
    const c = clock()
    const s = createUiSessionStore(new Database(':memory:'), c.now)
    const busy = s.create({ userId: 1 })
    for (let elapsed = 0; elapsed + 10 * 24 * 3600_000 < SESSION_ABSOLUTE_MS; elapsed += 10 * 24 * 3600_000) {
      c.t += 10 * 24 * 3600_000
      expect(s.verify(busy)).toBe(true)
    }
    c.t = 1_000_000 + SESSION_ABSOLUTE_MS + 1
    expect(s.verify(busy)).toBe(false)
    const idle = s.create()
    c.t += SESSION_IDLE_MS + SESSION_TOUCH_MS
    expect(s.verify(idle)).toBe(false)
  })
  test('an old ui_session table gains the columns and its rows stay valid', () => {
    const db = new Database(':memory:')
    const s0 = createUiSessionStore(db)
    const raw = s0.create()
    db.exec('CREATE TABLE old AS SELECT hash, created_at, last_seen FROM ui_session; DROP TABLE ui_session; ALTER TABLE old RENAME TO ui_session;')
    const s = createUiSessionStore(db)
    createUiSessionStore(db) // re-running the migration is a no-op
    expect(s.verify(raw)).toBe(true)
    expect(s.userOf(raw)).toBeNull()
  })
})
