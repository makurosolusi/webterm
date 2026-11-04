import { describe, expect, it } from 'vitest'
import { cronError, latestCronBetween, nextCronAfter } from './routineCron'
import { parseRoutineInput, routineTier, untrustedMayFire } from './routineModel'

// Local-time fixtures (cron is local time): build with the Date fields, compare with the same.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

describe('routine cron', () => {
  it('next run: hourly, weekly Monday 09:00, step and range', () => {
    expect(nextCronAfter('0 * * * *', at(2026, 11, 4, 10, 30))).toBe(at(2026, 11, 4, 11, 0))
    // 2026-11-04 is a Wednesday -> next Monday is 2026-11-09.
    expect(nextCronAfter('0 9 * * 1', at(2026, 11, 4, 10))).toBe(at(2026, 11, 9, 9, 0))
    expect(nextCronAfter('*/15 9-10 * * *', at(2026, 11, 4, 10, 50))).toBe(at(2026, 11, 5, 9, 0))
    expect(nextCronAfter('0 9 * * 7', at(2026, 11, 4))).toBe(at(2026, 11, 8, 9, 0)) // 7 = Sunday
  })

  it('strictly after: an exact slot moves to the following one', () => {
    expect(nextCronAfter('30 2 * * *', at(2026, 11, 4, 2, 30))).toBe(at(2026, 11, 5, 2, 30))
  })

  it('Vixie rule: both day fields restricted = either matches', () => {
    // 1st of the month OR Friday; from Wed 2026-11-04 the Friday 11-06 comes first.
    expect(nextCronAfter('0 0 1 * 5', at(2026, 11, 4))).toBe(at(2026, 11, 6))
  })

  it('Feb 29 is found years ahead', () => {
    expect(nextCronAfter('0 0 29 2 *', at(2026, 11, 4))).toBe(at(2028, 2, 29))
  })

  it('latest slot in a window, null when none', () => {
    expect(latestCronBetween('0 * * * *', at(2026, 11, 4, 1), at(2026, 11, 4, 10, 59))).toBe(at(2026, 11, 4, 10))
    expect(latestCronBetween('0 9 * * 1', at(2026, 11, 3), at(2026, 11, 4, 12))).toBeNull()
  })

  it('rejects malformed expressions with the field named', () => {
    expect(cronError('0 9 * *')).toMatch(/5 fields/)
    expect(cronError('61 * * * *')).toMatch(/minute/)
    expect(cronError('0 9 * * mon')).toMatch(/day of week/)
    expect(cronError('0 9 * * 1')).toBeNull()
  })
})

describe('routine input', () => {
  const base = { name: 'n', trigger: { type: 'api' }, action: { type: 'spawn', prompt: 'p' } }

  it('fills defaults and computes the tier', () => {
    const r = parseRoutineInput(base)
    expect(typeof r).toBe('object')
    if (typeof r === 'string') return
    expect(r.budget).toEqual({ maxRunsPerDay: 24, maxCostUsdPerDay: null })
    expect(r.enabled).toBe(true)
    expect(routineTier(r.action)).toBe('R2')
    expect(routineTier({ type: 'outbox', to: 'n1', body: 'b' })).toBe('R1')
    expect(untrustedMayFire('R2')).toBe(false)
    expect(untrustedMayFire('R1')).toBe(true)
  })

  it('refuses a bad cron, a match-everything pattern and a bad precheck timeout', () => {
    expect(parseRoutineInput({ ...base, trigger: { type: 'schedule', cron: '99 * * * *' } })).toMatch(/minute/)
    expect(parseRoutineInput({ ...base, trigger: { type: 'event', pattern: '*' } })).toMatch(/every event/)
    expect(parseRoutineInput({ ...base, trigger: { type: 'event', pattern: 'routine.finish' } })).toMatch(/routine events/)
    expect(parseRoutineInput({ ...base, precheck: { command: 'true', timeoutSeconds: 0 } })).toMatch(/timeoutSeconds/)
    expect(parseRoutineInput({ ...base, action: { type: 'outbox', to: 'bad id!', body: 'x' } })).toMatch(/node id/)
  })
})
