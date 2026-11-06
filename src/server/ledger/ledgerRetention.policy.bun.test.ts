// Lock (data-209-1, agent-211-C4): every table of the live ledger schema has a retention policy —
// a sweep, a real FK cascade from a covered parent, or an exemption with a reason. A new table
// without one fails here, so growth without an owner cannot come back unnoticed.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ensureSkillTable } from '../central/skills/skillIndex'
import { ensureCostSchema } from '../cost/costStore'
import { ensureInboxIndexes } from '../inbox/inboxIndexes'
import { migrate } from './migration'
import { RETENTION } from './ledgerRetention.policy'

/** The ledger as the server runs it: every migration plus the tables modules create lazily. */
function liveTables(): { db: Database; tables: string[] } {
  const db = new Database(':memory:')
  migrate(db)
  ensureCostSchema(db)
  ensureInboxIndexes(db)
  ensureSkillTable(db)
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  return { db, tables }
}

test('every live ledger table has a retention entry or an exemption with a reason', () => {
  const { tables } = liveTables()
  expect(tables.length).toBeGreaterThan(40)
  expect(tables.filter((t) => !(t in RETENTION))).toEqual([])
  for (const [table, entry] of Object.entries(RETENTION)) {
    if (entry.kind === 'exempt') expect({ table, reason: entry.reason.length >= 10 }).toEqual({ table, reason: true })
    else expect({ table, rule: entry.rule.length >= 10 }).toEqual({ table, rule: true })
  }
})

test('the registry names no table that does not exist (stale entries hide real gaps)', () => {
  const { tables } = liveTables()
  expect(Object.keys(RETENTION).filter((t) => !tables.includes(t))).toEqual([])
})

test('a cascade entry is a real ON DELETE CASCADE from a parent that is itself swept or cascaded', () => {
  const { db } = liveTables()
  for (const [table, entry] of Object.entries(RETENTION)) {
    if (entry.kind !== 'cascade') continue
    const fks = db.query(`PRAGMA foreign_key_list(${table})`).all() as { table: string; on_delete: string }[]
    expect({ table, cascades: fks.some((fk) => fk.table === entry.parent && fk.on_delete === 'CASCADE') }).toEqual({ table, cascades: true })
    expect({ table, parent: RETENTION[entry.parent]?.kind !== 'exempt' }).toEqual({ table, parent: true })
  }
})
