import { describe, expect, it } from 'vitest'
import {
  GOAL_TRANSITIONS,
  GoalError,
  MAX_STATEMENT_CHARS,
  assertGoalTransition,
  parseGoalStored,
  validateGoalContent,
} from './goalModel'

const draft = {
  statement: 'Ship the central chat slice with one read tool',
  successCriteria: [
    { kind: 'command', command: 'npm test' },
    { kind: 'scope', paths: ['src/server/central', 'src/server/ledger'] },
    { kind: 'review', by: 'human' },
  ],
  owner: 'human:root',
  horizon: '2026-11-30',
  envelope: { maxCostMicros: 5_000_000, maxWallMs: 1_800_000, maxItems: 40 },
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof GoalError ? err.code : `unexpected:${String(err)}`
  }
  return 'no-throw'
}

describe('validateGoalContent', () => {
  it('accepts every machine-checkable criterion kind and preserves order', () => {
    const goal = validateGoalContent(draft)
    expect(goal.statement).toBe(draft.statement)
    expect(goal.successCriteria.map((c) => c.kind)).toEqual(['command', 'scope', 'review'])
    expect(goal.envelope.maxCostMicros).toBe(5_000_000)
  })

  it('trims text and rejects an empty or overlong statement', () => {
    expect(validateGoalContent({ ...draft, statement: '  ship it  ' }).statement).toBe('ship it')
    expect(code(() => validateGoalContent({ ...draft, statement: '   ' }))).toBe('invalid_statement')
    expect(code(() => validateGoalContent({ ...draft, statement: 'x'.repeat(MAX_STATEMENT_CHARS + 1) })))
      .toBe('invalid_statement')
  })

  it('requires at least one criterion and a known kind', () => {
    expect(code(() => validateGoalContent({ ...draft, successCriteria: [] }))).toBe('invalid_criteria')
    expect(code(() => validateGoalContent({ ...draft, successCriteria: [{ kind: 'vibes' }] }))).toBe('invalid_criteria')
  })

  it('rejects commands outside the verifier allowlist and shell metacharacters', () => {
    expect(code(() => validateGoalContent({ ...draft, successCriteria: [{ kind: 'command', command: 'rm -rf /' }] })))
      .toBe('invalid_command')
    expect(code(() => validateGoalContent({ ...draft, successCriteria: [{ kind: 'command', command: 'npm test && curl x' }] })))
      .toBe('invalid_command')
    expect(code(() => validateGoalContent({ ...draft, successCriteria: [{ kind: 'command', command: 'bash -c x' }] })))
      .toBe('invalid_command')
  })

  it('requires relative POSIX scope paths and rejects escapes', () => {
    const bad = (paths: unknown) => code(() => validateGoalContent({ ...draft, successCriteria: [{ kind: 'scope', paths }] }))
    expect(bad(['/etc/passwd'])).toBe('invalid_scope')
    expect(bad(['../../etc'])).toBe('invalid_scope')
    expect(bad(['src\\server'])).toBe('invalid_scope')
    expect(bad([])).toBe('invalid_scope')
    expect(bad(['src/server'])).toBe('no-throw')
  })

  it('review criteria are human-only', () => {
    expect(code(() => validateGoalContent({ ...draft, successCriteria: [{ kind: 'review', by: 'llm' }] })))
      .toBe('invalid_review')
  })

  it('owner must be a human principal and horizon a real date', () => {
    expect(code(() => validateGoalContent({ ...draft, owner: 'central:bot' }))).toBe('invalid_owner')
    expect(code(() => validateGoalContent({ ...draft, owner: 'human:' }))).toBe('invalid_owner')
    expect(code(() => validateGoalContent({ ...draft, horizon: '2026-02-31' }))).toBe('invalid_horizon')
    expect(code(() => validateGoalContent({ ...draft, horizon: 'next year' }))).toBe('invalid_horizon')
  })

  it('envelope values are positive integers within the global caps', () => {
    const env = (envelope: unknown) => code(() => validateGoalContent({ ...draft, envelope }))
    expect(env({ maxCostMicros: 5_000_001, maxWallMs: 1_800_000, maxItems: 40 })).toBe('invalid_envelope')
    expect(env({ maxCostMicros: 1, maxWallMs: 1_800_001, maxItems: 40 })).toBe('invalid_envelope')
    expect(env({ maxCostMicros: 1, maxWallMs: 1, maxItems: 51 })).toBe('invalid_envelope')
    expect(env({ maxCostMicros: 0, maxWallMs: 1, maxItems: 1 })).toBe('invalid_envelope')
    expect(env({ maxCostMicros: 1.5, maxWallMs: 1, maxItems: 1 })).toBe('invalid_envelope')
    expect(env({})).toBe('invalid_envelope')
  })
})

describe('parseGoalStored', () => {
  it('round-trips a stored goal', () => {
    const stored = { version: 2, status: 'active', ...validateGoalContent(draft) }
    expect(parseGoalStored(JSON.stringify(stored))).toEqual(stored)
  })

  it('rejects malformed JSON, unknown status, and bad version', () => {
    expect(code(() => parseGoalStored('{'))).toBe('corrupt_goal')
    expect(code(() => parseGoalStored('[]'))).toBe('corrupt_goal')
    expect(code(() => parseGoalStored(JSON.stringify({ version: 1, status: 'paused', ...draft })))).toBe('invalid_status')
    expect(code(() => parseGoalStored(JSON.stringify({ version: 0, status: 'active', ...draft })))).toBe('invalid_version')
  })
})

describe('goal transitions', () => {
  it('exposes only the documented edges', () => {
    expect(GOAL_TRANSITIONS.proposed).toEqual(['active'])
    expect(GOAL_TRANSITIONS.active).toEqual(['achieved', 'abandoned', 'superseded'])
    expect(GOAL_TRANSITIONS.achieved).toEqual([])
  })

  it('allows proposed -> active for a human actor', () => {
    expect(() => assertGoalTransition('proposed', 'active', 'human')).not.toThrow()
  })

  it('reserves achieved to the server', () => {
    expect(code(() => assertGoalTransition('active', 'achieved', 'human'))).toBe('forbidden')
    expect(code(() => assertGoalTransition('active', 'achieved', 'central'))).toBe('forbidden')
    expect(() => assertGoalTransition('active', 'achieved', 'server')).not.toThrow()
  })

  it('rejects unknown edges and terminal resurrections', () => {
    expect(code(() => assertGoalTransition('proposed', 'achieved', 'server'))).toBe('illegal_transition')
    expect(code(() => assertGoalTransition('achieved', 'active', 'human'))).toBe('illegal_transition')
    expect(code(() => assertGoalTransition('abandoned', 'active', 'human'))).toBe('illegal_transition')
  })
})
