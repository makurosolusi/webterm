// Pure pixel math of the pane comparison: bring two captures to one size, then mark the pixels that differ.
// No DOM and no canvas, so it runs in a Web Worker, in a chunked main-thread fallback and in plain unit tests.

/** The part of ImageData the math needs; a real ImageData satisfies it. */
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }

export type SizeMode = 'fit' | 'actual'
export const MAX_WORK_PX = 1600 // longest side of the working size: keeps a weak machine responsive
export const MAX_THRESHOLD = 50

export interface DiffResult {
  /** Red where the pixels differ, transparent elsewhere; same size as the normalized inputs. */
  image: Pixels
  differing: number
  total: number
  /** 0-100, one decimal. */
  percent: number
}

export const makePixels = (width: number, height: number, data = new Uint8ClampedArray(width * height * 4)): Pixels => ({ width, height, data })

/** Nearest-neighbour copy of `src` scaled by `k` into the top-left of a transparent `w x h` image. */
function place(src: Pixels, k: number, w: number, h: number): Pixels {
  const sw = Math.max(1, Math.round(src.width * k)), sh = Math.max(1, Math.round(src.height * k))
  const out = makePixels(w, h)
  for (let y = 0; y < Math.min(sh, h); y++) {
    const row = Math.min(src.height - 1, Math.floor(y / k)) * src.width
    for (let x = 0; x < Math.min(sw, w); x++) {
      const si = (row + Math.min(src.width - 1, Math.floor(x / k))) * 4
      out.data.set(src.data.subarray(si, si + 4), (y * w + x) * 4)
    }
  }
  return out
}

/**
 * Two images at one common size. `fit`: both scaled to the width of `a` (aspect kept), height = the taller one.
 * `actual`: no scaling, each side the larger of the two. Either way capped to `maxDim` on the longest side.
 */
export function normalizePair(a: Pixels, b: Pixels, mode: SizeMode = 'fit', maxDim = MAX_WORK_PX): { a: Pixels; b: Pixels } {
  const kb = mode === 'fit' ? a.width / b.width : 1
  const w0 = mode === 'fit' ? a.width : Math.max(a.width, b.width)
  const h0 = Math.max(a.height, Math.round(b.height * kb))
  const cap = Math.min(1, maxDim / Math.max(w0, h0))
  if (a.width === b.width && a.height === b.height && cap === 1) return { a, b }
  const w = Math.max(1, Math.round(w0 * cap)), h = Math.max(1, Math.round(h0 * cap))
  return { a: place(a, cap, w, h), b: place(b, kb * cap, w, h) }
}

/**
 * Marks pixels of `a`/`b` (same size) whose largest channel distance, alpha included, exceeds `threshold` percent of 255.
 * Two fully transparent pixels are equal whatever their colour. Rows [from, to) only, written into `out`: the chunked
 * fallback calls this per slice. Returns the number of differing pixels in the slice.
 */
export function diffRows(a: Pixels, b: Pixels, threshold: number, out: Uint8ClampedArray, from: number, to: number): number {
  const limit = (Math.max(0, Math.min(MAX_THRESHOLD, threshold)) / 100) * 255
  let count = 0
  for (let i = from * a.width * 4, end = to * a.width * 4; i < end; i += 4) {
    if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]))
    if (d > limit) { out[i] = 255; out[i + 3] = 255; count++ }
  }
  return count
}

export function resultOf(image: Pixels, differing: number): DiffResult {
  const total = image.width * image.height
  return { image, differing, total, percent: total ? Math.round((differing / total) * 1000) / 10 : 0 }
}

/** Difference map of two images; different sizes are normalized ('fit') first. */
export function diffImages(a: Pixels, b: Pixels, threshold: number): DiffResult {
  const pair = a.width === b.width && a.height === b.height ? { a, b } : normalizePair(a, b, 'fit')
  const image = makePixels(pair.a.width, pair.a.height)
  return resultOf(image, diffRows(pair.a, pair.b, threshold, image.data, 0, image.height))
}
