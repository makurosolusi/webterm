/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActMsg } from '../shared/protocol'
import { ACT_MAX_HELD, ACT_TTL_MS, createActStore, resetSharedActStore, useCentralAct } from './centralAct.store'
import { dispatchBroadcast } from './ws.listeners'

const msg = (nodeId: string, over: Partial<ActMsg> = {}): ActMsg => ({ t: 'act', v: 1, tool: 'canvas.type', verb: 'typed', nodeId, n: 1, ...over })

describe('createActStore', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('merges frames for one node: n adds up, the latest verb wins', () => {
    const s = createActStore()
    s.record(msg('a', { n: 2 }))
    s.record(msg('a', { verb: 'drove', tool: 'browser_act', n: 3 }))
    const [e, ...rest] = s.getSnapshot().entries
    expect(rest).toEqual([])
    expect(e).toMatchObject({ nodeId: 'a', verb: 'drove', n: 5 })
  })

  it('lists the newest node first', () => {
    const s = createActStore()
    s.record(msg('a')); s.record(msg('b')); s.record(msg('a'))
    expect(s.getSnapshot().entries.map((e) => e.nodeId)).toEqual(['a', 'b'])
  })

  it('an entry expires ACT_TTL_MS after its last frame, not its first', () => {
    const s = createActStore()
    s.record(msg('a'))
    vi.advanceTimersByTime(ACT_TTL_MS - 1000)
    s.record(msg('a'))
    vi.advanceTimersByTime(ACT_TTL_MS - 1)
    expect(s.getSnapshot().entries).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(s.getSnapshot().entries).toEqual([])
  })

  it('holds at most ACT_MAX_HELD entries, counts the evicted, and resets the count when empty', () => {
    const s = createActStore()
    for (let i = 0; i < ACT_MAX_HELD + 7; i++) s.record(msg(`n${i}`))
    const snap = s.getSnapshot()
    expect(snap.entries).toHaveLength(ACT_MAX_HELD)
    expect(snap.dropped).toBe(7)
    expect(snap.entries.some((e) => e.nodeId === 'n0')).toBe(false) // the oldest went
    vi.advanceTimersByTime(ACT_TTL_MS)
    expect(s.getSnapshot()).toEqual({ entries: [], dropped: 0 })
  })

  it('notifies subscribers on record and on expiry; unsubscribe stops it', () => {
    const s = createActStore()
    const cb = vi.fn()
    const off = s.subscribe(cb)
    s.record(msg('a'))
    vi.advanceTimersByTime(ACT_TTL_MS)
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    s.record(msg('b'))
    expect(cb).toHaveBeenCalledTimes(2)
  })
})

describe('useCentralAct', () => {
  afterEach(() => { resetSharedActStore() })

  it('connects subscribeAct once for any number of users and disconnects with the last', () => {
    const a = renderHook(() => useCentralAct())
    const b = renderHook(() => useCentralAct())
    act(() => { dispatchBroadcast(msg('x')) })
    expect(a.result.current.entries).toHaveLength(1)
    expect(b.result.current.entries[0]?.n).toBe(1) // a second hookup would have made it 2
    a.unmount(); b.unmount()
    dispatchBroadcast(msg('y'))
    const c = renderHook(() => useCentralAct())
    expect(c.result.current.entries.map((e) => e.nodeId)).toEqual(['x']) // y arrived with nobody listening
  })
})
