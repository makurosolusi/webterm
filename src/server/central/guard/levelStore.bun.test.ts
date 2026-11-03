// Bun-only. Level ladder: min(env, global, project), lowering open, raising human-only.
import { expect, test } from 'bun:test'
import { envCeiling, effectiveLevelOf, minLevel, readLevel, setLevel } from './levelStore'
import { eventKinds, freshDb, HUMAN, T0 } from './controlGuard.testutil'

const now = () => T0
const none = {}

test('effective level is min(env ceiling, global, project)', () => {
  const db = freshDb()
  expect(effectiveLevelOf(db, 'p1', none)).toBe('propose')
  expect(effectiveLevelOf(db, 'p1', { WEBTERM_CENTRAL_AGENTS: 'propose' })).toBe('propose')
  expect(setLevel(db, { scope: 'global', level: 'act_envelope', actor: HUMAN, now }).ok).toBe(true)
  expect(effectiveLevelOf(db, 'p1', none)).toBe('propose')
  expect(effectiveLevelOf(db, 'p1', { WEBTERM_CENTRAL_AGENTS: 'propose' })).toBe('act_gated')
  expect(effectiveLevelOf(db, 'p1', { WEBTERM_CENTRAL_AGENTS: 'auto' })).toBe('act_envelope')
  expect(setLevel(db, { scope: 'project:p1', level: 'observe', actor: HUMAN, now }).ok).toBe(true)
  expect(effectiveLevelOf(db, 'p1', { WEBTERM_CENTRAL_AGENTS: 'auto' })).toBe('observe')
  expect(effectiveLevelOf(db, 'p2', { WEBTERM_CENTRAL_AGENTS: 'auto' })).toBe('act_envelope')
  expect(envCeiling({ WEBTERM_CENTRAL_AGENTS: 'bogus' })).toBe('propose')
  expect(minLevel('act_gated', 'observe', 'propose')).toBe('observe')
})

test('raise without a human token is refused, lowering by system is allowed', () => {
  const db = freshDb()
  const central = { kind: 'central', id: 'central-1' } as const
  const r = setLevel(db, { scope: 'global', level: 'act_envelope', actor: central, now })
  expect(r.ok).toBe(false)
  expect(r.ok ? '' : r.code).toBe('forbidden')
  expect(readLevel(db, 'global')).toBe(null)
  const worker = setLevel(db, { scope: 'global', level: 'off', actor: { kind: 'worker', id: 'w' }, now })
  expect(worker.ok).toBe(false)
  const down = setLevel(db, { scope: 'global', level: 'observe', actor: { kind: 'system', id: 'breaker' }, now })
  expect(down.ok).toBe(true)
  const up = setLevel(db, { scope: 'global', level: 'propose', actor: { kind: 'system', id: 'breaker' }, now })
  expect(up.ok).toBe(false)
  expect(readLevel(db, 'global')?.level).toBe('observe')
})

test('lowering applies at once, CAS conflicts and bad input are typed, changes are audited', () => {
  const db = freshDb()
  const a = setLevel(db, { scope: 'global', level: 'act_gated', actor: HUMAN, reason: 'go', now })
  expect(a.ok ? a.version : -1).toBe(1)
  expect(effectiveLevelOf(db, null, { WEBTERM_CENTRAL_AGENTS: 'auto' })).toBe('act_gated')
  const stale = setLevel(db, { scope: 'global', level: 'off', actor: HUMAN, expectedVersion: 0, now })
  expect(stale.ok ? '' : stale.code).toBe('conflict')
  const lowered = setLevel(db, { scope: 'global', level: 'off', actor: HUMAN, expectedVersion: 1, now })
  expect(lowered.ok ? lowered.version : -1).toBe(2)
  expect(effectiveLevelOf(db, null, { WEBTERM_CENTRAL_AGENTS: 'auto' })).toBe('off')
  const bad = setLevel(db, { scope: 'project:', level: 'off', actor: HUMAN, now })
  expect(bad.ok ? '' : bad.code).toBe('invalid')
  const audits = eventKinds(db, 'central.control')
  expect(audits.length).toBe(2)
  expect(audits[1]?.from).toBe('act_gated')
  expect(audits[1]?.to).toBe('off')
})
