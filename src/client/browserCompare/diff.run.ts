// Runs the pixel diff without blocking the UI: a Web Worker when there is one, else row slices spread over animation
// frames on the main thread. Both can be cancelled (AbortSignal); a cancelled run rejects with an AbortError.
import { diffRows, makePixels, normalizePair, resultOf } from './diff'
import type { DiffResult, Pixels } from './diff'
import type { DiffDone, DiffJob } from './diff.worker'

export const DIFF_SLICE_PIXELS = 250_000 // about a few ms per slice on a weak machine

export interface WorkerLike {
  postMessage(m: DiffJob): void
  terminate(): void
  onmessage: ((e: MessageEvent<DiffDone>) => void) | null
  onerror: ((e: unknown) => void) | null
}
export interface RunOptions {
  signal?: AbortSignal
  /** Test seam; the default builds the bundled worker, or returns null where Workers do not exist. */
  makeWorker?: () => WorkerLike | null
  /** Test seam: schedules the next slice (default requestAnimationFrame, then setTimeout). */
  schedule?: (fn: () => void) => void
}

const abortError = (): Error => Object.assign(new Error('Comparison cancelled'), { name: 'AbortError' })

function defaultWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
}
function defaultSchedule(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn())
  else setTimeout(fn, 0)
}

function inWorker(w: WorkerLike, a: Pixels, b: Pixels, threshold: number, signal?: AbortSignal): Promise<DiffResult> {
  return new Promise((resolve, reject) => {
    const done = (): void => { signal?.removeEventListener('abort', onAbort); w.onmessage = null; w.onerror = null; w.terminate() }
    const onAbort = (): void => { done(); reject(abortError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    w.onmessage = (e) => { done(); resolve(resultOf(makePixels(a.width, a.height, e.data.data), e.data.differing)) }
    w.onerror = () => { done(); reject(new Error('Comparison worker failed')) }
    w.postMessage({ a: a.data, b: b.data, width: a.width, height: a.height, threshold })
  })
}

function sliced(a: Pixels, b: Pixels, threshold: number, signal: AbortSignal | undefined, schedule: (fn: () => void) => void): Promise<DiffResult> {
  return new Promise((resolve, reject) => {
    const image = makePixels(a.width, a.height)
    const rows = Math.max(1, Math.floor(DIFF_SLICE_PIXELS / a.width))
    let row = 0, differing = 0
    const step = (): void => {
      if (signal?.aborted) return reject(abortError())
      const to = Math.min(a.height, row + rows)
      differing += diffRows(a, b, threshold, image.data, row, to)
      row = to
      if (row >= a.height) resolve(resultOf(image, differing))
      else schedule(step)
    }
    schedule(step)
  })
}

/** Diffs two captures of any size (normalized 'fit' first). */
export function runDiff(a: Pixels, b: Pixels, threshold: number, opts: RunOptions = {}): Promise<DiffResult> {
  if (opts.signal?.aborted) return Promise.reject(abortError())
  const pair = a.width === b.width && a.height === b.height ? { a, b } : normalizePair(a, b, 'fit')
  const worker = (opts.makeWorker ?? defaultWorker)()
  return worker ? inWorker(worker, pair.a, pair.b, threshold, opts.signal) : sliced(pair.a, pair.b, threshold, opts.signal, opts.schedule ?? defaultSchedule)
}
