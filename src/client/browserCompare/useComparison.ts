// Data side of the overlay: captures both panes once on open and on `refresh` (never on a timer), puts them at one size,
// and computes the difference map only while the Difference mode is shown (cancellable, off the main thread).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureError, captureTab } from './capture'
import type { Capture } from './capture'
import { normalizePair } from './diff'
import type { DiffResult, Pixels, SizeMode } from './diff'
import { runDiff } from './diff.run'
import type { RunOptions } from './diff.run'

export type CaptureSide = 'left' | 'right'
export type DiffState =
  | { kind: 'idle' }
  | { kind: 'computing' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: DiffResult }

export interface Comparison {
  status: 'loading' | 'ready'
  shots: { left?: Capture; right?: Capture }
  failures: { left?: CaptureError; right?: CaptureError }
  /** When the shots were taken (the older of the two). */
  capturedAt: Date | null
  /** Both captures at one working size; null until both exist. */
  pair: { a: Pixels; b: Pixels } | null
  /** Original sizes, for the "sizes differ" warning. */
  sizes: { a: { w: number; h: number }; b: { w: number; h: number } } | null
  diff: DiffState
  refresh(): void
  cancelDiff(): void
  recompute(): void
}

function grab(root: ParentNode, tabId: string): { shot?: Capture; failure?: CaptureError } {
  try { return { shot: captureTab(root, tabId) } } catch (e) {
    if (e instanceof CaptureError) return { failure: e }
    return { failure: new CaptureError('error', tabId, `Capturing tab ${tabId} failed: ${e instanceof Error ? e.message : String(e)}`) }
  }
}

export function useComparison(root: ParentNode | null, ids: { left: string; right: string }, sizeMode: SizeMode, threshold: number, diffOn: boolean, run: RunOptions = {}): Comparison {
  const [taken, setTaken] = useState<{ shots: Comparison['shots']; failures: Comparison['failures'] } | null>(null)
  const [diff, setDiff] = useState<DiffState>({ kind: 'idle' })
  const [round, setRound] = useState(0)
  const abort = useRef<AbortController | null>(null)
  const runRef = useRef(run)
  runRef.current = run

  const refresh = useCallback(() => {
    if (!root) return
    const l = grab(root, ids.left), r = grab(root, ids.right)
    setTaken({ shots: { left: l.shot, right: r.shot }, failures: { left: l.failure, right: r.failure } })
  }, [root, ids.left, ids.right])
  useEffect(() => { refresh() }, [refresh])

  const pair = useMemo(() => {
    const a = taken?.shots.left, b = taken?.shots.right
    return a && b ? normalizePair(a.pixels, b.pixels, sizeMode) : null
  }, [taken, sizeMode])

  useEffect(() => {
    abort.current?.abort()
    if (!diffOn || !pair) { setDiff({ kind: 'idle' }); return }
    const ctl = new AbortController()
    abort.current = ctl
    setDiff({ kind: 'computing' })
    runDiff(pair.a, pair.b, threshold, { ...runRef.current, signal: ctl.signal }).then(
      (result) => { if (!ctl.signal.aborted) setDiff({ kind: 'done', result }) },
      (e: unknown) => {
        if (ctl.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return
        setDiff({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => ctl.abort()
  }, [diffOn, pair, threshold, round])

  const cancelDiff = useCallback(() => { abort.current?.abort(); setDiff({ kind: 'cancelled' }) }, [])
  const recompute = useCallback(() => setRound((n) => n + 1), [])

  const a = taken?.shots.left, b = taken?.shots.right
  const times = [a?.at, b?.at].filter((d): d is Date => !!d)
  return {
    status: taken ? 'ready' : 'loading',
    shots: taken?.shots ?? {}, failures: taken?.failures ?? {},
    capturedAt: times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null,
    pair, diff, refresh, cancelDiff, recompute,
    sizes: a && b ? { a: { w: a.pixels.width, h: a.pixels.height }, b: { w: b.pixels.width, h: b.pixels.height } } : null,
  }
}
