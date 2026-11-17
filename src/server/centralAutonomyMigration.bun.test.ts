// Bun-only. The 2026-11-17 autonomy-default migrations: once, idempotent, never over an owner's choice.
import { expect, test } from 'bun:test'
import { eventKinds, freshDb, HUMAN, T0 } from './central/guard/controlGuard.testutil'
import { readLevel, setLevel } from './central/guard/levelStore'
import { execWrite } from './ledger/ledgerCore'
import { migrateAgentsEnvDefault, migrateGlobalLevelDefault } from './centralAutonomyMigration'

function flags() {
  const m = new Map<string, string>()
  return { getFlag: (k: string) => m.get(k) ?? null, setFlag: (k: string, v: string) => void m.set(k, v) }
}
const insertGlobal = (db: ReturnType<typeof freshDb>, level: string, reason: string | null, by: string) =>
  execWrite(db, 'INSERT INTO central_control (scope, level, reason, set_by, set_at, version) VALUES (?, ?, ?, ?, ?, 1)', 'global', level, reason, by, T0)

test('level: an old default propose row (no reason, not the owner) rises once, with an audit event', () => {
  const db = freshDb()
  insertGlobal(db, 'propose', null, 'system:default')
  const f = flags()
  expect(migrateGlobalLevelDefault({ db, now: () => T0, ...f })).toBe('moved')
  expect(readLevel(db, 'global')).toMatchObject({ level: 'act_envelope', version: 2 })
  expect(eventKinds(db, 'central.control')[0]).toMatchObject({ scope: 'global', from: 'propose', to: 'act_envelope', actorKind: 'system' })
  expect(migrateGlobalLevelDefault({ db, now: () => T0, ...f })).toBe('skipped')
  expect(eventKinds(db, 'central.control').length).toBe(1)
})

test('level: a row with a reason, or set by the owner, is a choice and stays; per-project rows are untouched', () => {
  const withReason = freshDb()
  insertGlobal(withReason, 'propose', 'I want to approve every worker', 'system:default')
  expect(migrateGlobalLevelDefault({ db: withReason, now: () => T0, ...flags() })).toBe('marked')
  expect(readLevel(withReason, 'global')?.level).toBe('propose')

  const byOwner = freshDb()
  expect(setLevel(byOwner, { scope: 'global', level: 'propose', actor: HUMAN, now: () => T0 }).ok).toBe(true)
  expect(setLevel(byOwner, { scope: 'project:p1', level: 'propose', actor: HUMAN, now: () => T0 }).ok).toBe(true)
  expect(migrateGlobalLevelDefault({ db: byOwner, now: () => T0, ...flags() })).toBe('marked')
  expect(readLevel(byOwner, 'global')?.level).toBe('propose')
  expect(readLevel(byOwner, 'project:p1')?.level).toBe('propose')
})

test('level: no row at all is marked, and a later explicit propose is final', () => {
  const db = freshDb()
  const f = flags()
  expect(migrateGlobalLevelDefault({ db, now: () => T0, ...f })).toBe('marked')
  insertGlobal(db, 'propose', null, 'system:default')
  expect(migrateGlobalLevelDefault({ db, now: () => T0, ...f })).toBe('skipped')
  expect(readLevel(db, 'global')?.level).toBe('propose')
})

test('env: a stored override propose (the old card default) moves to auto once; shell/.env and other values stay', () => {
  const saved: string[] = []
  const f = flags()
  const deps = (stored: { value: string; source: 'override' | 'env' | 'default' } | null) => ({ ...f, stored: () => stored, save: (v: 'auto') => void saved.push(v) })
  expect(migrateAgentsEnvDefault(deps({ value: 'propose', source: 'override' }))).toBe('moved')
  expect(saved).toEqual(['auto'])
  expect(migrateAgentsEnvDefault(deps({ value: 'propose', source: 'override' }))).toBe('skipped')
  for (const s of [{ value: 'propose', source: 'env' as const }, { value: 'off', source: 'override' as const }, null]) {
    expect(migrateAgentsEnvDefault({ ...flags(), stored: () => s, save: (v) => void saved.push(v) })).toBe('marked')
  }
  expect(saved).toEqual(['auto'])
})
