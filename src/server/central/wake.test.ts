import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWaker, wakeReasonFor, WAKE_DEBOUNCE_MS, WAKE_SWEEP_MS } from './wake'
import { createEventBus } from '../events/eventBus'
import type { SenseEvent } from '../events/eventModel'

afterEach(() => vi.useRealTimers())

function setup() {
  vi.useFakeTimers()
  const calls: string[] = []
  const waker = createWaker({ onWake: (reason) => { calls.push(reason) } })
  return { calls, waker }
}

describe('waker', () => {
  it('coalesces a burst into one callback after exactly 250 ms', () => {
    const { calls, waker } = setup()
    waker.start()
    waker.wake('a')
    vi.advanceTimersByTime(100)
    waker.wake('b')
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS - 101)
    expect(calls).toEqual([])
    expect(waker.pending).toBe(true)
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['a'])
    expect(waker.pending).toBe(false)
    waker.wake('c')
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(calls).toEqual(['a', 'c'])
    waker.stop()
  })

  it('sweeps every 60 s as a safety net even without wakes', () => {
    const { calls, waker } = setup()
    waker.start()
    vi.advanceTimersByTime(WAKE_SWEEP_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(WAKE_SWEEP_MS)
    expect(calls).toEqual(['sweep', 'sweep'])
    waker.stop()
  })

  it('stop() clears the sweep and a pending debounce, and later wakes are ignored', () => {
    const { calls, waker } = setup()
    waker.start()
    waker.start()
    expect(vi.getTimerCount()).toBe(1)
    waker.wake('x')
    expect(vi.getTimerCount()).toBe(2)
    waker.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(waker.running).toBe(false)
    waker.wake('late')
    vi.advanceTimersByTime(WAKE_SWEEP_MS * 2)
    expect(calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    waker.stop()
  })

  it('ignores wake() before start()', () => {
    const { calls, waker } = setup()
    waker.wake('early')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(calls).toEqual([])
  })

  it('survives a throwing or rejecting handler and keeps sweeping', async () => {
    vi.useFakeTimers()
    let n = 0
    const waker = createWaker({
      onWake: () => {
        n++
        if (n === 1) throw new Error('boom')
        return Promise.reject(new Error('later'))
      },
    })
    waker.start()
    vi.advanceTimersByTime(WAKE_SWEEP_MS * 2)
    await Promise.resolve()
    expect(n).toBe(2)
    expect(waker.running).toBe(true)
    waker.stop()
  })
})

const ev = (kind: string, trust: SenseEvent['trust'] = 'trusted', payload: unknown = null): SenseEvent => ({
  seq: 0, ts: 0, kind, source: 'test', actor: 'test', subject: null, workspaceId: null, nodeId: null,
  trust, dedupeKey: null, payload, prevHash: '', hash: '',
})

describe('waker Senses producers (F1-d)', () => {
  function rigBus(allowEvent?: (e: SenseEvent) => boolean) {
    vi.useFakeTimers()
    const bus = createEventBus()
    const calls: Array<{ reason: string; reasons: readonly string[] }> = []
    const waker = createWaker({ bus, allowEvent, onWake: (reason, reasons) => { calls.push({ reason, reasons }) } })
    return { bus, calls, waker }
  }

  it('maps hook idle / needs-input, edge change and test fail; ignores the rest', () => {
    expect(wakeReasonFor(ev('hook.Stop'))).toBe('agent_idle')
    expect(wakeReasonFor(ev('hook.Notification', 'trusted', { notificationType: 'idle_prompt' }))).toBe('agent_idle')
    expect(wakeReasonFor(ev('hook.Notification', 'trusted', { notificationType: 'agent_needs_input' }))).toBe('agent_needs_input')
    expect(wakeReasonFor(ev('hook.Notification', 'trusted', { notificationType: 'auth_success' }))).toBeNull()
    expect(wakeReasonFor(ev('edge.change'))).toBe('edge_change')
    expect(wakeReasonFor(ev('test.fail'))).toBe('test_fail')
    expect(wakeReasonFor(ev('hook.PostToolUse'))).toBeNull()
    expect(wakeReasonFor(ev('fs.change'))).toBeNull()
  })

  it('a burst of events becomes one debounced wake with the distinct reasons', () => {
    const { bus, calls, waker } = rigBus()
    waker.start()
    bus.publish(ev('hook.Stop'))
    bus.publish(ev('edge.change'))
    bus.publish(ev('hook.Stop'))
    bus.publish(ev('hook.PostToolUse'))
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual([{ reason: 'agent_idle', reasons: ['agent_idle', 'edge_change'] }])
    bus.publish(ev('test.fail'))
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(calls[1]).toEqual({ reason: 'test_fail', reasons: ['test_fail'] })
    waker.stop()
  })

  it('untrusted events do not wake by default; the gate seam can admit them', () => {
    const strict = rigBus()
    strict.waker.start()
    strict.bus.publish(ev('edge.change', 'untrusted'))
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(strict.calls).toEqual([])
    strict.waker.stop()

    const open = rigBus(() => true)
    open.waker.start()
    open.bus.publish(ev('edge.change', 'untrusted'))
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS)
    expect(open.calls.map((c) => c.reason)).toEqual(['edge_change'])
    open.waker.stop()
  })

  it('events before start or after stop do nothing, and stop unsubscribes', () => {
    const { bus, calls, waker } = rigBus()
    bus.publish(ev('hook.Stop'))
    waker.start()
    expect(bus.subscriberCount).toBe(3)
    waker.stop()
    expect(bus.subscriberCount).toBe(0)
    bus.publish(ev('hook.Stop'))
    vi.advanceTimersByTime(WAKE_DEBOUNCE_MS * 2)
    expect(calls).toEqual([])
  })
})
