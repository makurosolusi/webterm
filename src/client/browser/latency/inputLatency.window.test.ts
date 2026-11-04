import { describe, expect, it } from 'vitest'
import type { ClientMsg, FrameLatency } from '../../../shared/browser.contract'
import {
  createLatencyWindow, LATENCY_BUDGET_MS, LATENCY_IDLE_MS, percentile, recordFrame, summarize, toneOf, wantsStamp,
} from './inputLatency.window'

const arr = (...v: number[]) => Float64Array.from(v)
// test-only: server stages 2 + 10 + 3 = 15 ms
const lat = (ls: number): FrameLatency => ({ ls, rxToDispatch: 2, dispatchToSwap: 10, swapToServer: 3 })

describe('percentile (nearest-rank, Orca diagnostic-summary)', () => {
  it('picks observed values, never interpolates', () => {
    const v = arr(50, 10, 40, 20, 30)
    const s = new Float64Array(5)
    expect(percentile(v, 5, 0.5, s)).toBe(30)
    expect(percentile(v, 5, 0.95, s)).toBe(50)
    expect(percentile(v, 5, 0, s)).toBe(10)
    expect(Array.from(v)).toEqual([50, 10, 40, 20, 30]) // input untouched
  })
  it('only reads the first n values; empty is NaN', () => {
    const s = new Float64Array(4)
    expect(percentile(arr(5, 1, 999, 999), 2, 0.95, s)).toBe(5)
    expect(percentile(arr(), 0, 0.5, s)).toBeNaN()
  })
  it('p95 of 1..100 is 95, p50 is 50', () => {
    const v = Float64Array.from({ length: 100 }, (_, i) => 100 - i)
    const s = new Float64Array(100)
    expect(percentile(v, 100, 0.95, s)).toBe(95)
    expect(percentile(v, 100, 0.5, s)).toBe(50)
  })
})

describe('recordFrame', () => {
  it('splits total into server stages, client paint and network remainder', () => {
    const w = createLatencyWindow(4)
    // sent at 1000, frame received at 1030, painted at 1034 -> total 34, paint 4, network 34-15-4 = 15
    expect(recordFrame(w, lat(1000), 1030, 1034)).toBe(true)
    expect(w.total[0]).toBe(34)
    expect(w.stages.clientPaint[0]).toBe(4)
    expect(w.stages.network[0]).toBe(15)
    expect(w.stages.dispatchToSwap[0]).toBe(10)
    expect(w.lastAt).toBe(1034)
  })
  it('rejects samples from another clock (negative total or negative network) and absurd totals', () => {
    const w = createLatencyWindow(4)
    expect(recordFrame(w, lat(2000), 1030, 1034)).toBe(false) // ls in the future
    expect(recordFrame(w, lat(1025), 1030, 1034)).toBe(false) // total 9 < server 15 + paint 4
    expect(recordFrame(w, lat(0), 3000, 3000)).toBe(false) // > 2 s
    expect(w.count).toBe(0)
  })
  it('is a rolling window: oldest sample is overwritten once full', () => {
    const w = createLatencyWindow(3)
    for (const total of [100, 20, 30, 40]) recordFrame(w, lat(10_000 - total), 10_000, 10_000)
    expect(w.count).toBe(3)
    expect(Array.from(w.total).sort((a, b) => a - b)).toEqual([20, 30, 40])
  })
})

describe('toneOf (budget)', () => {
  it('green up to good, amber up to warn, red above', () => {
    expect(toneOf(LATENCY_BUDGET_MS.good)).toBe('good')
    expect(toneOf(LATENCY_BUDGET_MS.good + 0.1)).toBe('warn')
    expect(toneOf(LATENCY_BUDGET_MS.warn)).toBe('warn')
    expect(toneOf(LATENCY_BUDGET_MS.warn + 0.1)).toBe('bad')
  })
})

describe('summarize', () => {
  it('null before any sample and once idle', () => {
    const w = createLatencyWindow(8)
    expect(summarize(w, 5000)).toBeNull()
    recordFrame(w, lat(4960), 5000, 5000) // total 40
    expect(summarize(w, 5000)).toMatchObject({ p50: 40, p95: 40, tone: 'good', count: 1 })
    expect(summarize(w, 5000 + LATENCY_IDLE_MS)).not.toBeNull()
    expect(summarize(w, 5001 + LATENCY_IDLE_MS)).toBeNull()
  })
  it('tone follows p95, not p50', () => {
    const w = createLatencyWindow(20)
    for (let i = 0; i < 19; i++) recordFrame(w, lat(10_000 - 30), 10_000, 10_000)
    recordFrame(w, lat(10_000 - 300), 10_000, 10_000)
    const s = summarize(w, 10_000)!
    expect(s.p50).toBe(30)
    expect(s.p95).toBe(30) // 1 slow of 20 sits above the 95th percentile
    expect(s.tone).toBe('good')
    recordFrame(w, lat(10_000 - 300), 10_000, 10_000) // overwrites one 30: 2 of 20 slow
    expect(summarize(w, 10_000)).toMatchObject({ p50: 30, p95: 300, tone: 'bad' })
  })
})

describe('wantsStamp', () => {
  it('stamps inputs that usually repaint; skips mousemove, keyup and non-input', () => {
    const mouse = (type: string) => ({ t: 'mouse', id: 'n', type, x: 0, y: 0, button: 'none', buttons: 0, clickCount: 0, mods: 0, dx: 0, dy: 0 }) as ClientMsg
    const key = (type: string) => ({ t: 'key', id: 'n', type, key: 'a', code: 'KeyA', text: 'a', vk: 65, mods: 0 }) as ClientMsg
    expect(wantsStamp(mouse('wheel'))).toBe(true)
    expect(wantsStamp(mouse('down'))).toBe(true)
    expect(wantsStamp(mouse('move'))).toBe(false)
    expect(wantsStamp(key('down'))).toBe(true)
    expect(wantsStamp(key('up'))).toBe(false)
    expect(wantsStamp({ t: 'text', id: 'n', text: 'x' })).toBe(true)
    expect(wantsStamp({ t: 'ack', id: 'n', seq: 1 })).toBe(false)
    expect(wantsStamp({ t: 'nav', id: 'n', action: 'reload' })).toBe(false)
  })
})
