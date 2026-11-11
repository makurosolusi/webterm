// Per-key save state: two keys never clear each other, and a newer save of a key wins over a late reply.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSaveStates, SAVED_SHOW_MS } from './settingsSave'

afterEach(() => { vi.useRealTimers() })

describe('createSaveStates', () => {
  it('keeps one state per key; "saved" clears after SAVED_SHOW_MS', () => {
    vi.useFakeTimers()
    const s = createSaveStates()
    const a = s.start(['a'])
    const b = s.start(['b'])
    a({ ok: true })
    expect(s.get('a')?.status).toBe('saved')
    expect(s.get('b')?.status).toBe('saving') // a's answer does not touch b
    b({ ok: false, message: 'nope', retry: () => undefined })
    expect(s.get('b')).toMatchObject({ status: 'error', message: 'nope' })
    vi.advanceTimersByTime(SAVED_SHOW_MS)
    expect(s.get('a')).toBeUndefined()
    expect(s.get('b')?.status).toBe('error') // an error stays until the next save
  })

  it('a late answer of an older save of the same key is ignored', () => {
    const s = createSaveStates()
    const listener = vi.fn()
    s.subscribe(listener)
    const first = s.start(['k'])
    const second = s.start(['k'])
    first({ ok: false, message: 'old', retry: () => undefined })
    expect(s.get('k')?.status).toBe('saving')
    second({ ok: true })
    expect(s.get('k')?.status).toBe('saved')
    expect(listener).toHaveBeenCalledTimes(3) // two starts + the second answer
  })
})
