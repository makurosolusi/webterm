import { describe, expect, it } from 'vitest'
import {
  BLOCKED_MS, CONTEXT_WARN_PCT, DELEGATION_START_MS, OUTBOX_STUCK_MS, STALL_MS,
  anomaliesOf, blockedTooLong, contextFull, delegationNotStarted, disconnected, exitedUnexpectedly, formatAge, outboxTrouble, stalled,
  type StatusBarFacts,
} from './nodeStatusBar.rules'

const NOW = 10_000_000
const f = (o: Partial<StatusBarFacts> = {}): StatusBarFacts => ({ now: NOW, connection: 'connected', ...o })

describe('node status bar anomaly rules', () => {
  it('a healthy node has no anomaly', () => {
    expect(anomaliesOf(f({ status: 'working', lastOutputAt: NOW - 1000, contextPct: 40, outbox: { queued: 0 } }))).toEqual([])
  })

  it('exit: non-zero self exit and failed start are red; code 0 and closes are not', () => {
    expect(exitedUnexpectedly(f({ exit: { code: 137, reason: 'self', at: NOW } }))).toMatchObject({ level: 'error', reason: expect.stringContaining('137') })
    expect(exitedUnexpectedly(f({ exit: { code: 1, reason: 'failed', at: NOW } }))?.level).toBe('error')
    expect(exitedUnexpectedly(f({ exit: { code: 0, reason: 'self', at: NOW } }))).toBeNull()
    expect(exitedUnexpectedly(f({ exit: { code: 129, reason: 'closed', at: NOW } }))).toBeNull()
    expect(exitedUnexpectedly(f({ exit: { code: 129, reason: 'peer-closed', at: NOW } }))).toBeNull()
  })

  it('stalled: working with neither output nor hook for STALL_MS', () => {
    const quiet = { status: 'working' as const, lastOutputAt: NOW - STALL_MS, lastHookAt: NOW - STALL_MS - 1 }
    expect(stalled(f(quiet))).toMatchObject({ level: 'warn', reason: 'Working, but no output or hook for 5m.' })
    expect(stalled(f({ ...quiet, lastHookAt: NOW - 1000 }))).toBeNull()
    expect(stalled(f({ ...quiet, status: 'waiting' }))).toBeNull()
    expect(stalled(f({ status: 'working' }))).toBeNull() // nothing known yet: no guess
  })

  it('outbox: a failure after the last delivery is red, old queued mail is amber', () => {
    expect(outboxTrouble(f({ outbox: { queued: 0, lastFailedAt: NOW - 10, lastDeliveredAt: NOW - 20 } }))?.level).toBe('error')
    expect(outboxTrouble(f({ outbox: { queued: 0, lastFailedAt: NOW - 20, lastDeliveredAt: NOW - 10 } }))).toBeNull()
    expect(outboxTrouble(f({ outbox: { queued: 2, oldestQueuedAt: NOW - OUTBOX_STUCK_MS } })))
      .toMatchObject({ level: 'warn', reason: '2 queued messages have waited 5m in the outbox.' })
    expect(outboxTrouble(f({ outbox: { queued: 2, oldestQueuedAt: NOW - OUTBOX_STUCK_MS + 1 } }))).toBeNull()
  })

  it('delegation: still assigned after DELEGATION_START_MS and never working', () => {
    const work = { title: 't', status: 'assigned' as const, startedAt: NOW - DELEGATION_START_MS }
    expect(delegationNotStarted(f({ work, status: 'waiting' }))?.reason).toContain('Prompt may not have been submitted')
    expect(delegationNotStarted(f({ work, status: 'working' }))).toBeNull()
    expect(delegationNotStarted(f({ work: { ...work, status: 'running' } }))).toBeNull()
    expect(delegationNotStarted(f({ work: { ...work, startedAt: NOW - 1000 } }))).toBeNull()
  })

  it('blocked: waiting for permission longer than BLOCKED_MS', () => {
    expect(blockedTooLong(f({ status: 'blocked', statusSince: NOW - BLOCKED_MS }))?.reason).toBe('Waiting for your permission for 3m.')
    expect(blockedTooLong(f({ status: 'blocked', statusSince: NOW - 1000 }))).toBeNull()
    expect(blockedTooLong(f({ status: 'blocked' }))).toBeNull()
  })

  it('stream: reconnecting amber, offline/auth red, first connect quiet', () => {
    expect(disconnected(f({ connection: 'reconnecting' }))?.level).toBe('warn')
    expect(disconnected(f({ connection: 'offline' }))?.level).toBe('error')
    expect(disconnected(f({ connection: 'auth' }))?.level).toBe('error')
    expect(disconnected(f({ connection: 'connecting' }))).toBeNull()
  })

  it('context: at or above CONTEXT_WARN_PCT', () => {
    expect(contextFull(f({ contextPct: CONTEXT_WARN_PCT }))?.reason).toContain('90%')
    expect(contextFull(f({ contextPct: CONTEXT_WARN_PCT - 0.1 }))).toBeNull()
  })

  it('anomaliesOf orders red before amber', () => {
    const all = anomaliesOf(f({ connection: 'reconnecting', exit: { code: 2, reason: 'self', at: NOW }, contextPct: 95 }))
    expect(all.map((a) => [a.id, a.level])).toEqual([['exit', 'error'], ['stream', 'warn'], ['context', 'warn']])
  })

  it('formatAge', () => {
    expect([formatAge(-5), formatAge(59_999), formatAge(60_000), formatAge(3_660_000), formatAge(7_200_000), formatAge(90_000_000)])
      .toEqual(['0s', '59s', '1m', '1h 1m', '2h', '1d'])
  })
})
