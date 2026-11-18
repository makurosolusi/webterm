// Split layout of one browser node: the terminal's pane tree (`Pane`, workspace.shape.ts) whose leaves are TAB ids
// instead of shell ids. Pure and shared: the client renders/edits it, the server validates it and keeps it in step
// with tab closes. No layout = one pane showing the active tab (every board saved before splits existed).
// Rules: each leaf shows ONE tab, a tab shows in at most one pane, at most MAX_PANES panes, the last pane never goes.
import type { Pane, PaneLeaf, PaneSplit } from './workspace.shape'

export const MAX_PANES = 4
export const PANE_LIMIT_REASON = `Pane limit (${MAX_PANES}) reached`
/** Smallest pane (CSS px per side) the UI lets a separator reach; below this the node asks to be enlarged. */
export const MIN_PANE_PX = 160
/** Ratio bounds shared with the terminal tree (paneTree.MIN_RATIO). */
export const MIN_RATIO = 0.1
/** Where a dragged tab lands relative to a pane (VS Code editor-group drop zones). */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom'
export type Direction = 'left' | 'right' | 'up' | 'down'

/** A browser layout: leaf `id` = tabId. */
export type BrowserLayout = Pane

const isLeaf = (p: Pane): p is PaneLeaf => 'id' in p
const MAX_DEPTH = 3

/** Tab ids shown by the layout, left-to-right / top-to-bottom. */
export function layoutTabIds(p: Pane): string[] {
  return isLeaf(p) ? [p.id] : [...layoutTabIds(p.a), ...layoutTabIds(p.b)]
}
export const paneCount = (p: Pane): number => layoutTabIds(p).length

export type CanSplit = { ok: true } | { ok: false; reason: string }
export const canSplit = (p: Pane | null | undefined): CanSplit => (p && paneCount(p) >= MAX_PANES ? { ok: false, reason: PANE_LIMIT_REASON } : { ok: true })

const clampRatio = (r: number): number => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, Number.isFinite(r) ? r : 0.5))
const dirOf = (e: DropEdge): PaneSplit['dir'] => (e === 'left' || e === 'right' ? 'h' : 'v')
const newFirst = (e: DropEdge): boolean => e === 'left' || e === 'top'

function mapLeaf(p: Pane, id: string, f: (leaf: PaneLeaf) => Pane): Pane {
  if (isLeaf(p)) return p.id === id ? f(p) : p
  const a = mapLeaf(p.a, id, f)
  const b = mapLeaf(p.b, id, f)
  return a === p.a && b === p.b ? p : { ...p, a, b }
}

/**
 * Show `newTabId` in a new pane beside `target`, on `edge` of it. `root` null = the node has no layout yet (one pane showing `target`).
 * Refused (same value back) when the limit is reached, `target` is not shown, or `newTabId` is already shown.
 */
export function splitPane(root: Pane | null, target: string, newTabId: string, edge: DropEdge): Pane {
  const base: Pane = root ?? { id: target }
  const ids = layoutTabIds(base)
  if (!ids.includes(target) || ids.includes(newTabId) || !canSplit(base).ok) return base
  const dir = dirOf(edge)
  return mapLeaf(base, target, (leaf) => (newFirst(edge) ? { dir, ratio: 0.5, a: { id: newTabId }, b: leaf } : { dir, ratio: 0.5, a: leaf, b: { id: newTabId } }))
}

function drop(p: Pane, id: string): Pane | null {
  if (isLeaf(p)) return p.id === id ? null : p
  const a = drop(p.a, id)
  const b = drop(p.b, id)
  if (!a) return b
  if (!b) return a
  return a === p.a && b === p.b ? p : { ...p, a, b }
}

/** Remove the pane showing `tabId`; its sibling takes the space. The last pane (or an unknown tab) is refused: same value back. */
export function closePane(root: Pane, tabId: string): Pane {
  if (!layoutTabIds(root).includes(tabId) || isLeaf(root)) return root
  return drop(root, tabId) ?? root
}

/** One pane means no split: store nothing. */
export const normalizeLayout = (p: Pane | null | undefined): Pane | null => (p && !isLeaf(p) ? p : null)

/** The pane showing `paneTabId` shows `newTabId` instead; when another pane already shows it, the two panes swap. */
export function assignTab(root: Pane, paneTabId: string, newTabId: string): Pane {
  const ids = layoutTabIds(root)
  if (paneTabId === newTabId || !ids.includes(paneTabId)) return root
  if (ids.includes(newTabId)) return swapPanes(root, paneTabId, newTabId)
  return mapLeaf(root, paneTabId, () => ({ id: newTabId }))
}

/** Exchange the tabs of two panes (the geometry stays). */
export function swapPanes(root: Pane, a: string, b: string): Pane {
  const ids = layoutTabIds(root)
  if (a === b || !ids.includes(a) || !ids.includes(b)) return root
  const swap = (p: Pane): Pane => {
    if (isLeaf(p)) return p.id === a ? { id: b } : p.id === b ? { id: a } : p
    return { ...p, a: swap(p.a), b: swap(p.b) }
  }
  return swap(root)
}

/** New ratio for the split at `path` ('' = root, then 'a'/'b' steps), clamped to [MIN_RATIO, 1-MIN_RATIO]. */
export function resizePane(root: Pane, path: string, ratio: number): Pane {
  if (isLeaf(root)) return root
  if (path === '') {
    const r = clampRatio(ratio)
    return r === root.ratio ? root : { ...root, ratio: r }
  }
  const rest = path.slice(1)
  if (path[0] === 'a') { const a = resizePane(root.a, rest, ratio); return a === root.a ? root : { ...root, a } }
  if (path[0] === 'b') { const b = resizePane(root.b, rest, ratio); return b === root.b ? root : { ...root, b } }
  return root
}

interface Rect { id: string; l: number; t: number; r: number; b: number }
function rects(p: Pane, box = { l: 0, t: 0, r: 1, b: 1 }): Rect[] {
  if (isLeaf(p)) return [{ id: p.id, ...box }]
  if (p.dir === 'h') {
    const x = box.l + (box.r - box.l) * p.ratio
    return [...rects(p.a, { ...box, r: x }), ...rects(p.b, { ...box, l: x })]
  }
  const y = box.t + (box.b - box.t) * p.ratio
  return [...rects(p.a, { ...box, b: y }), ...rects(p.b, { ...box, t: y })]
}

/** Tab of the pane next to `from` in `dir` (nearest by centre among panes that lie that way); `from` itself when none does. */
export function focusPane(root: Pane, from: string, dir: Direction): string {
  const all = rects(root)
  const me = all.find((r) => r.id === from)
  if (!me) return from
  const cx = (me.l + me.r) / 2, cy = (me.t + me.b) / 2
  const eps = 1e-6
  const lies = (r: Rect): boolean => (dir === 'left' ? r.r <= me.l + eps : dir === 'right' ? r.l >= me.r - eps : dir === 'up' ? r.b <= me.t + eps : r.t >= me.b - eps)
  const dist = (r: Rect): number => Math.hypot((r.l + r.r) / 2 - cx, (r.t + r.b) / 2 - cy)
  const best = all.filter((r) => r.id !== from && lies(r)).sort((x, y) => dist(x) - dist(y))[0]
  return best?.id ?? from
}

/**
 * The tab `closedId` is going away. Its pane shows the nearest tab that is not on screen (right neighbour, then left, in
 * strip order) or, when every tab is on screen, collapses. Returns the new layout (null = no split left) and the tab the
 * focus should land on.
 */
export function layoutAfterClose(root: Pane, closedId: string, order: readonly string[]): { layout: Pane | null; focus: string } {
  const shown = new Set(layoutTabIds(root))
  if (!shown.has(closedId)) return { layout: root, focus: layoutTabIds(root)[0] }
  const i = order.indexOf(closedId)
  const free = (id: string): boolean => id !== closedId && !shown.has(id)
  const sub = [...order.slice(i + 1), ...order.slice(0, Math.max(i, 0)).reverse()].find(free)
  if (sub) return { layout: normalizeLayout(mapLeaf(root, closedId, () => ({ id: sub }))), focus: sub }
  const next = drop(root, closedId)
  return { layout: normalizeLayout(next), focus: next ? layoutTabIds(next)[0] : '' }
}

const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function sanitize(v: unknown, seen: Set<string>, known: ReadonlySet<string> | undefined, depth: number): Pane | null {
  if (!isObj(v) || depth > MAX_DEPTH) return null
  if ('id' in v) {
    if (typeof v.id !== 'string' || !TAB_ID.test(v.id) || seen.has(v.id) || (known && !known.has(v.id)) || seen.size >= MAX_PANES) return null
    seen.add(v.id)
    return { id: v.id }
  }
  if (v.dir !== 'h' && v.dir !== 'v') return null
  const a = sanitize(v.a, seen, known, depth + 1)
  const b = sanitize(v.b, seen, known, depth + 1)
  if (!a || !b) return a ?? b // a side that is junk or a vanished tab collapses into its sibling
  return { dir: v.dir, ratio: clampRatio(typeof v.ratio === 'number' ? v.ratio : 0.5), a, b }
}

/** Board/wire value as a safe layout: junk dropped, tabs not in `known` collapsed away, over-limit panes cut; undefined = no split (fewer than 2 panes). */
export function validLayout(v: unknown, known?: Iterable<string>): Pane | undefined {
  return normalizeLayout(sanitize(v, new Set(), known ? new Set(known) : undefined, 0)) ?? undefined
}
