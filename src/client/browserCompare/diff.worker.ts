// Web Worker entry: diffs two equal-size pixel buffers off the main thread (see diff.run.ts).
import { diffRows, makePixels } from './diff'

export interface DiffJob { a: Uint8ClampedArray; b: Uint8ClampedArray; width: number; height: number; threshold: number }
export interface DiffDone { data: Uint8ClampedArray; differing: number }

const scope = self as unknown as { onmessage: ((e: MessageEvent<DiffJob>) => void) | null; postMessage(m: DiffDone, t: Transferable[]): void }
scope.onmessage = (e) => {
  const { a, b, width, height, threshold } = e.data
  const out = makePixels(width, height)
  const differing = diffRows(makePixels(width, height, a), makePixels(width, height, b), threshold, out.data, 0, height)
  scope.postMessage({ data: out.data, differing }, [out.data.buffer])
}
