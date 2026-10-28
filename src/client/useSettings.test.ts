// Node-env (tanpa DOM): yang dites adalah coalescer MURNI, bukan hook-nya.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCoalescer, SAVE_COALESCE_MS } from './useSettings'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const spread = { merge: (p: Record<string, unknown>, n: Record<string, unknown>) => ({ ...p, ...n }) }

describe('createCoalescer', () => {
  it('turns a burst of pushes into one send carrying the merged payload', () => {
    const send = vi.fn(async () => {})
    const c = createCoalescer(send, spread)
    c.push({ fontSize: 13 })
    c.push({ fontSize: 14 })
    c.push({ cursorBlink: false })
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SAVE_COALESCE_MS)
    expect(send).toHaveBeenCalledTimes(1)
    // Kunci yang disetel lebih awal di jendela yang sama tidak boleh hilang.
    expect(send).toHaveBeenCalledWith({ fontSize: 14, cursorBlink: false })
  })

  it('opens a fresh window after the previous one fired', () => {
    const send = vi.fn(async () => {})
    const c = createCoalescer(send, spread)
    c.push({ a: 1 })
    vi.advanceTimersByTime(SAVE_COALESCE_MS)
    c.push({ b: 2 })
    vi.advanceTimersByTime(SAVE_COALESCE_MS)
    expect(send).toHaveBeenCalledTimes(2)
    // Jendela kedua mulai bersih — bukan akumulasi dari yang sudah terkirim.
    expect(send).toHaveBeenLastCalledWith({ b: 2 })
  })

  it('flush sends the pending payload immediately and cancels the timer', () => {
    const send = vi.fn(async () => {})
    const c = createCoalescer(send, spread)
    c.push({ a: 1 })
    c.flush()
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SAVE_COALESCE_MS * 4)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('flush with nothing pending is a no-op', () => {
    const send = vi.fn(async () => {})
    const c = createCoalescer(send, spread)
    c.flush()
    c.push({ a: 1 })
    vi.advanceTimersByTime(SAVE_COALESCE_MS)
    c.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('reports a failed send instead of leaving an unhandled rejection', async () => {
    const onError = vi.fn()
    const err = new Error('PUT /api/settings -> 500')
    const c = createCoalescer(async () => { throw err }, { onError })
    c.push({ a: 1 })
    c.flush()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('defaults to last-wins when no merge is given', () => {
    const send = vi.fn(async () => {})
    const c = createCoalescer(send, { ms: 50 })
    c.push('a')
    c.push('b')
    vi.advanceTimersByTime(50)
    expect(send).toHaveBeenCalledWith('b')
  })
})
