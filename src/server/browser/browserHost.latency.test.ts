import { describe, expect, it } from 'vitest'
import { INPUT_LATENCY_STALE_MS } from '../../shared/browser.contract'
import type { Frame } from '../../shared/browser.contract'
import { frameLatency, newRec, notePendingInput, pushFrame } from './browserHost.targets'

const T0 = 1_758_326_400_000 // test-only: epoch ms

describe('frame matching by CDP metadata.timestamp (I1-d)', () => {
  it('first frame swapped after dispatch carries the breakdown; earlier frames do not', () => {
    const rec = newRec('n', 'w', '')
    notePendingInput(rec, 42.5, T0, T0 + 2)
    expect(frameLatency(rec, { timestamp: (T0 + 1) / 1000 }, T0 + 3)).toBeUndefined() // swapped before input landed
    expect(rec.lat).toBeDefined()
    const lat = frameLatency(rec, { timestamp: (T0 + 20) / 1000 }, T0 + 23)
    expect(lat?.ls).toBe(42.5)
    expect(lat?.rxToDispatch).toBe(2)
    expect(lat?.dispatchToSwap).toBeCloseTo(18, 3)
    expect(lat?.swapToServer).toBeCloseTo(3, 3)
    expect(rec.lat).toBeUndefined()
    expect(frameLatency(rec, { timestamp: (T0 + 40) / 1000 }, T0 + 41)).toBeUndefined() // nothing pending
  })

  it('keeps the first input of a burst', () => {
    const rec = newRec('n', 'w', '')
    notePendingInput(rec, 1, T0, T0)
    notePendingInput(rec, 2, T0 + 5, T0 + 5)
    expect(frameLatency(rec, { timestamp: (T0 + 10) / 1000 }, T0 + 10)?.ls).toBe(1)
  })

  it('a stale pending input is replaced, and a frame long after dispatch is dropped', () => {
    const rec = newRec('n', 'w', '')
    notePendingInput(rec, 1, T0, T0)
    notePendingInput(rec, 2, T0 + INPUT_LATENCY_STALE_MS + 1, T0 + INPUT_LATENCY_STALE_MS + 1)
    expect(rec.lat?.ls).toBe(2)
    expect(frameLatency(rec, { timestamp: (T0 + 3 * INPUT_LATENCY_STALE_MS) / 1000 }, T0)).toBeUndefined()
    expect(rec.lat).toBeUndefined()
  })

  it('missing or bad metadata never matches', () => {
    const rec = newRec('n', 'w', '')
    notePendingInput(rec, 1, T0, T0)
    expect(frameLatency(rec, undefined, T0)).toBeUndefined()
    expect(frameLatency(rec, { timestamp: 'x' }, T0)).toBeUndefined()
    expect(frameLatency(rec, { timestamp: NaN }, T0)).toBeUndefined()
    expect(rec.lat).toBeDefined()
  })

  it('pushFrame attaches lat only to the matching frame', () => {
    const rec = newRec('n', 'w', '')
    const got: Frame[] = []
    rec.cast = { onFrame: (f) => got.push(f), seq: 0, acks: new Map() }
    const now = Date.now()
    notePendingInput(rec, 7, now - 2, now - 1)
    pushFrame(rec, { data: '', sessionId: 1, metadata: { timestamp: (now - 10) / 1000 } })
    pushFrame(rec, { data: '', sessionId: 2, metadata: { timestamp: (now + 5) / 1000 } })
    expect(got[0].lat).toBeUndefined()
    expect(got[1].lat?.ls).toBe(7)
  })
})
