// Bun-only: audit di atas bun:sqlite sungguhan (skema idempoten lewat openDb, pemangkasan 1000, tanpa nilai).
import { expect, test } from 'bun:test'
import { openDb } from './db'
import { AUDIT_MAX_ROWS, ensureAuditSchema, recordAudit, type AuditEntry } from './featureCapabilities.audit'

const entry = (detail: string): AuditEntry => ({ capability: 'advanced', action: 'denied', peer: 'remote', via: 'rejected', detail })
const rows = (db: ReturnType<typeof openDb>) => db.query('SELECT * FROM capability_audit ORDER BY id').all() as Array<Record<string, unknown>>

test('openDb membuat tabel; ensureAuditSchema dua kali aman', () => {
  const db = openDb(':memory:')
  ensureAuditSchema(db)
  ensureAuditSchema(db)
  recordAudit(db, entry('origin'), 123)
  expect(rows(db)).toEqual([{ id: 1, at: 123, capability: 'advanced', action: 'denied', peer: 'remote', via: 'rejected', detail: 'origin' }])
})

test('pemangkasan menyimpan AUDIT_MAX_ROWS terbaru', () => {
  const db = openDb(':memory:')
  for (let i = 0; i < AUDIT_MAX_ROWS + 5; i++) recordAudit(db, entry(`k${i}`))
  const all = rows(db)
  expect(all).toHaveLength(AUDIT_MAX_ROWS)
  expect(all[0]?.detail).toBe('k5')
  expect(all.at(-1)?.detail).toBe(`k${AUDIT_MAX_ROWS + 4}`)
})

test('detail dipotong dan baris tidak memuat nilai uji', () => {
  const db = openDb(':memory:')
  recordAudit(db, entry('A'.repeat(500)))
  recordAudit(db, { capability: 'advanced', action: 'advanced', peer: 'loopback', via: 'ui' })
  const all = rows(db)
  expect((all[0]?.detail as string).length).toBe(200)
  expect(all[1]?.detail).toBeNull()
  expect(JSON.stringify(all)).not.toContain('SENTINEL')
})
