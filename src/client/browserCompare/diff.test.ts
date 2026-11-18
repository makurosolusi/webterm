// jsdom has no canvas, so ImageData is a plain {width,height,data} stand-in (Pixels); the math is identical.
import { describe, expect, it } from 'vitest'
import { DIFF_SLICE_PIXELS, runDiff } from './diff.run'
import type { WorkerLike } from './diff.run'
import { diffImages, diffRows, makePixels, normalizePair } from './diff'
import type { Pixels } from './diff'

const solid = (w: number, h: number, rgba: [number, number, number, number]): Pixels => {
  const p = makePixels(w, h)
  for (let i = 0; i < p.data.length; i += 4) p.data.set(rgba, i)
  return p
}
const at = (p: Pixels, x: number, y: number): number[] => Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4))

describe('diffImages', () => {
  it('identical images differ by 0%', () => {
    const r = diffImages(solid(4, 4, [10, 20, 30, 255]), solid(4, 4, [10, 20, 30, 255]), 0)
    expect(r.differing).toBe(0)
    expect(r.percent).toBe(0)
    expect(Array.from(r.image.data).every((v) => v === 0)).toBe(true)
  })

  it('marks a single changed pixel red and reports its share', () => {
    const a = solid(10, 10, [0, 0, 0, 255]), b = solid(10, 10, [0, 0, 0, 255])
    b.data.set([255, 255, 255, 255], (3 * 10 + 4) * 4)
    const r = diffImages(a, b, 0)
    expect(r.differing).toBe(1)
    expect(r.percent).toBe(1)
    expect(at(r.image, 4, 3)).toEqual([255, 0, 0, 255])
    expect(at(r.image, 0, 0)).toEqual([0, 0, 0, 0])
  })

  it('ignores differences within the tolerance and flags those above it', () => {
    const a = solid(2, 2, [100, 100, 100, 255]), b = solid(2, 2, [110, 100, 100, 255]) // distance 10 = 3.9%
    expect(diffImages(a, b, 0).percent).toBe(100)
    expect(diffImages(a, b, 3).percent).toBe(100)
    expect(diffImages(a, b, 4).percent).toBe(0)
  })

  it('clamps the tolerance to 0-50', () => {
    const a = solid(1, 1, [0, 0, 0, 255]), b = solid(1, 1, [255, 255, 255, 255])
    expect(diffImages(a, b, 500).percent).toBe(100) // 50% of 255 is still below 255
    expect(diffImages(a, b, -5).percent).toBe(100)
  })

  it('compares alpha, and treats two transparent pixels as equal whatever their colour', () => {
    expect(diffImages(solid(1, 1, [0, 0, 0, 255]), solid(1, 1, [0, 0, 0, 128]), 10).percent).toBe(100)
    expect(diffImages(solid(1, 1, [255, 0, 0, 0]), solid(1, 1, [0, 255, 0, 0]), 0).percent).toBe(0)
  })

  it('normalizes different sizes to the width of the base before comparing', () => {
    const r = diffImages(solid(4, 4, [9, 9, 9, 255]), solid(2, 2, [9, 9, 9, 255]), 0)
    expect([r.image.width, r.image.height, r.percent]).toEqual([4, 4, 0])
  })

  it('counts the uncovered area of a shorter capture as different', () => {
    const r = diffImages(solid(4, 4, [9, 9, 9, 255]), solid(4, 2, [9, 9, 9, 255]), 0)
    expect(r.percent).toBe(50)
  })

  it('diffRows over slices adds up to the whole', () => {
    const a = solid(4, 4, [0, 0, 0, 255]), b = solid(4, 4, [255, 0, 0, 255])
    const out = new Uint8ClampedArray(64)
    expect(diffRows(a, b, 0, out, 0, 2) + diffRows(a, b, 0, out, 2, 4)).toBe(16)
  })
})

describe('normalizePair', () => {
  it('actual mode keeps pixels unscaled on a canvas as large as the larger side', () => {
    const { a, b } = normalizePair(solid(2, 2, [1, 1, 1, 255]), solid(4, 3, [2, 2, 2, 255]), 'actual')
    expect([a.width, a.height, b.width, b.height]).toEqual([4, 3, 4, 3])
    expect(at(a, 1, 1)).toEqual([1, 1, 1, 255])
    expect(at(a, 3, 2)).toEqual([0, 0, 0, 0])
  })

  it('caps the working size on the longest side', () => {
    const { a } = normalizePair(solid(40, 20, [1, 1, 1, 255]), solid(40, 20, [1, 1, 1, 255]), 'fit', 10)
    expect([a.width, a.height]).toEqual([10, 5])
  })
})

describe('runDiff', () => {
  const a = solid(8, 8, [0, 0, 0, 255]), b = solid(8, 8, [0, 0, 0, 255])
  b.data.set([255, 0, 0, 255], 0)

  it('chunks on the main thread without a worker, one slice per scheduled tick', async () => {
    const big = solid(1000, 600, [0, 0, 0, 255]), big2 = solid(1000, 600, [0, 0, 0, 255])
    big2.data.set([255, 255, 255, 255], 0)
    let ticks = 0
    const r = await runDiff(big, big2, 0, { makeWorker: () => null, schedule: (fn) => { ticks++; queueMicrotask(fn) } })
    expect(r.differing).toBe(1)
    expect(ticks).toBe(Math.ceil(600 / Math.floor(DIFF_SLICE_PIXELS / 1000)))
  })

  it('cancelling stops the sliced run with an AbortError', async () => {
    const ctl = new AbortController()
    const p = runDiff(a, b, 0, { makeWorker: () => null, signal: ctl.signal, schedule: (fn) => { ctl.abort(); queueMicrotask(fn) } })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses the worker when there is one and terminates it after the answer', async () => {
    const calls: string[] = []
    const w: WorkerLike = {
      onmessage: null, onerror: null,
      postMessage(job) { calls.push('post'); const out = new Uint8ClampedArray(job.a.length); queueMicrotask(() => w.onmessage?.({ data: { data: out, differing: 7 } } as MessageEvent)) },
      terminate() { calls.push('terminate') },
    }
    const r = await runDiff(a, b, 0, { makeWorker: () => w })
    expect(r.differing).toBe(7)
    expect(calls).toEqual(['post', 'terminate'])
  })

  it('cancelling terminates the worker', async () => {
    const ctl = new AbortController()
    let terminated = 0
    const w: WorkerLike = { onmessage: null, onerror: null, postMessage() { queueMicrotask(() => ctl.abort()) }, terminate() { terminated++ } }
    await expect(runDiff(a, b, 0, { makeWorker: () => w, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(terminated).toBe(1)
  })

  it('a worker failure rejects with context and still releases the worker', async () => {
    let terminated = 0
    const w: WorkerLike = { onmessage: null, onerror: null, postMessage() { queueMicrotask(() => w.onerror?.(new Error('x'))) }, terminate() { terminated++ } }
    await expect(runDiff(a, b, 0, { makeWorker: () => w })).rejects.toThrow('Comparison worker failed')
    expect(terminated).toBe(1)
  })
})
