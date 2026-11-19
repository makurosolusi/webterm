// Pure reveal/mask logic for the Monaco secret-masking view (no DOM, no React).
// The display text always has the SAME UTF-16 length as the source, so offsets, Ln/Col and
// line count match the original model.

/** Structural copy of the detector's range (kept local: the detector lives in src/shared). */
export interface MaskRange { from: number; to: number; kind: string }
/** Structural copy of the detector's result. */
export interface MaskScan { fileWide: boolean; ranges: MaskRange[]; truncated: boolean }
/** Immutable reveal state: `all` shows everything, `indexes` are positions in `scan.ranges`. */
export interface RevealState { readonly all: boolean; readonly indexes: ReadonlySet<number> }

export const MASK_CHAR = '•'

const HIDDEN: RevealState = { all: false, indexes: new Set<number>() }

/** Nothing revealed. */
export const hiddenState = (): RevealState => HIDDEN
/** Reveal every secret. */
export const revealAll = (s: RevealState): RevealState => (s.all ? s : { all: true, indexes: s.indexes })
/** Hide every secret again. */
export const hideAll = (): RevealState => HIDDEN
/** Reveal one range by its index in `scan.ranges`. */
export function revealIndex(s: RevealState, i: number): RevealState {
  if (s.all || s.indexes.has(i)) return s
  return { all: false, indexes: new Set([...s.indexes, i]) }
}
/** Whether range `i` is currently shown in clear text. */
export const isRevealed = (s: RevealState, i: number): boolean => s.all || s.indexes.has(i)
/** True when anything is currently revealed (drives auto-hide and listeners). */
export const hasReveal = (s: RevealState): boolean => s.all || s.indexes.size > 0

/** Number of still-masked secrets, for the "N secrets masked" badge. A file-wide mask counts as one. */
export function countMasked(scan: MaskScan, s: RevealState): number {
  if (s.all) return 0
  if (scan.fileWide) return 1
  let n = 0
  scan.ranges.forEach((_, i) => { if (!s.indexes.has(i)) n++ })
  return n
}

/** Index of the range containing `offset` (from <= offset < to), or -1. */
export function rangeAtOffset(scan: MaskScan, offset: number): number {
  return scan.ranges.findIndex((r) => offset >= r.from && offset < r.to)
}

function maskSpan(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/[^\r\n]/g, MASK_CHAR)
}

/**
 * Same-length display text. Every UTF-16 code unit of a masked span (except \r and \n) becomes a
 * bullet, so a surrogate pair becomes two bullets and lengths never drift. `fileWide` masks the
 * whole text. When `scan.truncated` is set the detector stopped early: text past its coverage was
 * never scanned and is shown as-is. Overlapping or out-of-bounds ranges are clamped, never doubled.
 */
export function maskText(text: string, scan: MaskScan, reveal: RevealState): string {
  if (reveal.all) return text
  if (scan.fileWide) return maskSpan(text, 0, text.length)
  const order = scan.ranges.map((r, i) => ({ r, i })).sort((a, b) => a.r.from - b.r.from)
  let out = ''
  let pos = 0
  for (const { r, i } of order) {
    const from = Math.max(r.from, pos)
    const to = Math.min(r.to, text.length)
    if (to <= from) continue
    out += text.slice(pos, from)
    out += reveal.indexes.has(i) ? text.slice(from, to) : maskSpan(text, from, to)
    pos = to
  }
  return out + text.slice(pos)
}

export interface AutoHideOptions {
  seconds: number
  onHide: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}
export interface AutoHide { touch: () => void; stop: () => void }

/** Idle timer: `touch()` (re)starts it, `stop()` cancels, `seconds <= 0` never fires. */
export function createAutoHide(o: AutoHideOptions): AutoHide {
  const set = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = o.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let id: unknown = null
  const stop = () => { if (id !== null) { clear(id); id = null } }
  const touch = () => {
    stop()
    if (o.seconds <= 0) return
    id = set(() => { id = null; o.onHide() }, o.seconds * 1000)
  }
  return { touch, stop }
}
