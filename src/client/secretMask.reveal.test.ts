import { describe, expect, it, vi } from 'vitest'
import {
  countMasked, createAutoHide, hiddenState, hideAll, isRevealed, maskText, rangeAtOffset, revealAll,
  revealIndex, type MaskScan,
} from './secretMask.reveal'

const scanOf = (ranges: [number, number][], extra: Partial<MaskScan> = {}): MaskScan =>
  ({ fileWide: false, truncated: false, ranges: ranges.map(([from, to]) => ({ from, to, kind: 'k' })), ...extra })

describe('maskText', () => {
  const text = 'A=secret1\nB=secret22\r\nC=ok'
  const scan = scanOf([[2, 9], [12, 20]])
  it('keeps length, newlines and line count', () => {
    const out = maskText(text, scan, hiddenState())
    expect(out).toHaveLength(text.length)
    expect(out).toBe('A=•••••••\nB=••••••••\r\nC=ok')
    expect(out.split('\n')).toHaveLength(text.split('\n').length)
  })
  it('reveals one value only', () => {
    const out = maskText(text, scan, revealIndex(hiddenState(), 0))
    expect(out.startsWith('A=secret1\nB=•')).toBe(true)
  })
  it('reveal all returns the original; hideAll masks again', () => {
    expect(maskText(text, scan, revealAll(hiddenState()))).toBe(text)
    expect(maskText(text, scan, hideAll())).not.toBe(text)
  })
  it('fileWide masks every non-newline char', () => {
    const out = maskText('ab\ncd\r\n', scanOf([], { fileWide: true }), hiddenState())
    expect(out).toBe('••\n••\r\n')
  })
  it('keeps UTF-16 length with surrogate pairs', () => {
    const t = 'k=\u{1F600}x'
    const out = maskText(t, scanOf([[2, 5]]), hiddenState())
    expect(out).toHaveLength(t.length)
    expect(out).toBe('k=•••')
  })
  it('overlapping and out-of-bounds ranges are not doubled', () => {
    const out = maskText('abcdefgh', scanOf([[4, 12], [1, 5]]), hiddenState())
    expect(out).toBe('a•••••••')
    expect(out).toHaveLength(8)
  })
  it('truncated scans leave unscanned text as-is', () => {
    expect(maskText('abcdef', scanOf([[0, 2]], { truncated: true }), hiddenState())).toBe('••cdef')
  })
})

describe('reveal state', () => {
  const scan = scanOf([[0, 1], [2, 3], [4, 5]])
  it('is immutable and counts masked', () => {
    const h = hiddenState()
    const r = revealIndex(h, 1)
    expect(h.indexes.size).toBe(0)
    expect(isRevealed(r, 1)).toBe(true)
    expect(isRevealed(r, 0)).toBe(false)
    expect(countMasked(scan, h)).toBe(3)
    expect(countMasked(scan, r)).toBe(2)
    expect(countMasked(scan, revealAll(r))).toBe(0)
    expect(isRevealed(revealAll(h), 2)).toBe(true)
  })
  it('fileWide counts as one until revealed all', () => {
    const fw = scanOf([], { fileWide: true })
    expect(countMasked(fw, hiddenState())).toBe(1)
    expect(countMasked(fw, revealAll(hiddenState()))).toBe(0)
  })
})

describe('rangeAtOffset', () => {
  const scan = scanOf([[2, 5], [8, 9]])
  it('finds the containing range, half-open', () => {
    expect(rangeAtOffset(scan, 2)).toBe(0)
    expect(rangeAtOffset(scan, 4)).toBe(0)
    expect(rangeAtOffset(scan, 5)).toBe(-1)
    expect(rangeAtOffset(scan, 8)).toBe(1)
  })
})

describe('createAutoHide', () => {
  it('fires after the delay and touch resets it', () => {
    vi.useFakeTimers()
    const onHide = vi.fn()
    const a = createAutoHide({ seconds: 30, onHide })
    a.touch()
    vi.advanceTimersByTime(20_000)
    a.touch()
    vi.advanceTimersByTime(20_000)
    expect(onHide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(onHide).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('stop cancels; seconds=0 never fires; injectable timers are used', () => {
    vi.useFakeTimers()
    const onHide = vi.fn()
    const a = createAutoHide({ seconds: 5, onHide })
    a.touch(); a.stop()
    createAutoHide({ seconds: 0, onHide }).touch()
    vi.advanceTimersByTime(60_000)
    expect(onHide).not.toHaveBeenCalled()
    const setTimer = vi.fn(() => 7)
    const clearTimer = vi.fn()
    const b = createAutoHide({ seconds: 2, onHide, setTimer, clearTimer })
    b.touch(); b.stop()
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 2000)
    expect(clearTimer).toHaveBeenCalledWith(7)
    vi.useRealTimers()
  })
})
