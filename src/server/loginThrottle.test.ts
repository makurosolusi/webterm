// Login throttle: free tries, doubling backoff, cap, success reset, forget, bounded map.
import { describe, expect, it } from 'vitest'
import { BACKOFF_AFTER, BASE_BACKOFF_MS, FORGET_MS, MAX_BACKOFF_MS, createLoginThrottle, throttleKeys } from './loginThrottle'

const setup = (max?: number) => {
  const c = { t: 0 }
  return { c, th: createLoginThrottle(() => c.t, max) }
}

describe('loginThrottle', () => {
  it('allows BACKOFF_AFTER-1 failures, then waits 1 s doubling, capped', () => {
    const { c, th } = setup()
    const k = ['user:alice']
    for (let i = 1; i < BACKOFF_AFTER; i++) th.fail(k)
    expect(th.check(k)).toEqual({ ok: true })
    th.fail(k)
    expect(th.check(k)).toEqual({ ok: false, retryAfterMs: BASE_BACKOFF_MS })
    th.fail(k)
    expect(th.check(k)).toEqual({ ok: false, retryAfterMs: 2 * BASE_BACKOFF_MS })
    for (let i = 0; i < 40; i++) th.fail(k)
    expect(th.check(k)).toEqual({ ok: false, retryAfterMs: MAX_BACKOFF_MS })
    c.t += MAX_BACKOFF_MS
    expect(th.check(k)).toEqual({ ok: true }) // never permanent
  })
  it('any throttled key blocks; success clears; quiet keys are forgotten', () => {
    const { c, th } = setup()
    const keys = throttleKeys('Alice', '127.0.0.1')
    expect(keys).toEqual(['user:alice', 'ip:127.0.0.1'])
    for (let i = 0; i < BACKOFF_AFTER; i++) th.fail(['ip:127.0.0.1'])
    expect(th.check(keys).ok).toBe(false)
    th.succeed(keys)
    expect(th.check(keys).ok).toBe(true)
    for (let i = 0; i < BACKOFF_AFTER - 1; i++) th.fail(keys)
    c.t += FORGET_MS + 1
    th.fail(keys)
    expect(th.check(keys).ok).toBe(true) // counter restarted
  })
  it('evicts the least recently failed key past the bound', () => {
    const { th } = setup(3)
    const lock = (k: string) => { for (let i = 0; i < BACKOFF_AFTER; i++) th.fail([k]) }
    lock('a'); lock('b'); lock('c'); lock('a'); lock('d')
    expect(th.check(['b']).ok).toBe(true) // evicted
    expect(th.check(['a']).ok).toBe(false)
    expect(th.check(['d']).ok).toBe(false)
  })
})
