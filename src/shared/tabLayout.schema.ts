// Per-workspace "tab mode" layout (Orca style): the same nodes shown as a tab strip + one visible
// tab, with the Files node docked as a side panel. It is purely a VIEW of the workspace: nodes,
// cables and canvas positions are never changed by it. Persisted as `Workspace.layout` (one JSON
// column, see server/db.layout.ts).
//
// Values arrive over HTTP and can be hand-edited, so `normalizeTabLayout` coerces any input field
// by field (wrong type -> default, duplicate ids dropped, width clamped). `reconcileTabs` is the
// pure step that keeps `order`/`active` in line with the nodes that actually exist.
import type { WsNodeKind } from './workspace.shape'

export type LayoutMode = 'canvas' | 'tabs'
export const LAYOUT_MODES: readonly LayoutMode[] = ['canvas', 'tabs']

export interface FilesPanelState { open: boolean; width: number }

export interface TabsState {
  /** Every node id, left to right: the order of the node tab strip above the canvas and of tab
   *  mode. Files nodes are in it too (draggable on the canvas strip); tab mode skips them because
   *  it docks Files as its side panel instead of a tab. */
  order: string[]
  /** Visible tab in tab mode (a non-Files id from `order`), or null when there are no tabs. */
  active: string | null
  filesPanel: FilesPanelState
}

export interface TabLayout { mode: LayoutMode; tabs: TabsState }

/** Files panel width in px: below `min` the tree is unreadable, above `max` it starves the tab. */
export const FILES_PANEL_WIDTH = { min: 180, max: 640, default: 280 } as const

/** Caps: the layout travels inside the workspace PUT body and one SQLite column. */
export const TAB_LAYOUT_LIMITS = { tabs: 500, idLength: 128 } as const

/** Node kinds that are NOT tabs. Files is the docked panel; every other kind (agent, terminal,
 *  editor, browser, diff, plan, app) is a tab so no node becomes unreachable in tab mode. */
const PANEL_KINDS: readonly WsNodeKind[] = ['files']
export const isTabKind = (kind: WsNodeKind): boolean => !PANEL_KINDS.includes(kind)

export function defaultTabLayout(): TabLayout {
  return { mode: 'canvas', tabs: { order: [], active: null, filesPanel: { open: true, width: FILES_PANEL_WIDTH.default } } }
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Clamp a panel width into `FILES_PANEL_WIDTH`; non-finite -> default. */
export function clampFilesPanelWidth(v: unknown): number {
  const { min, max, default: d } = FILES_PANEL_WIDTH
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(min, Math.round(v)), max) : d
}

/** Valid, unique, bounded node ids of an untrusted value. */
function cleanIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  for (const id of v) {
    if (seen.size >= TAB_LAYOUT_LIMITS.tabs) break
    if (typeof id === 'string' && id !== '' && id.length <= TAB_LAYOUT_LIMITS.idLength) seen.add(id)
  }
  return [...seen]
}

/** Coerce any value into a valid `TabLayout`, field by field. */
export function normalizeTabLayout(v: unknown): TabLayout {
  const s = record(v)
  const t = record(s.tabs)
  const f = record(t.filesPanel)
  const order = cleanIds(t.order)
  return {
    mode: LAYOUT_MODES.includes(s.mode as LayoutMode) ? (s.mode as LayoutMode) : 'canvas',
    tabs: {
      order,
      active: typeof t.active === 'string' && order.includes(t.active) ? t.active : null,
      filesPanel: { open: typeof f.open === 'boolean' ? f.open : true, width: clampFilesPanelWidth(f.width) },
    },
  }
}

/** Nearest surviving tab to where `active` used to sit: right neighbour first, then left. */
function nearestSurvivor(oldOrder: readonly string[], active: string | null, alive: ReadonlySet<string>): string | null {
  const at = active === null ? -1 : oldOrder.indexOf(active)
  if (at < 0) return null
  for (let i = at + 1; i < oldOrder.length; i++) if (alive.has(oldOrder[i])) return oldOrder[i]
  for (let i = at - 1; i >= 0; i--) if (alive.has(oldOrder[i])) return oldOrder[i]
  return null
}

/**
 * Bring `layout.tabs` in line with the existing nodes: drop ids that are gone, append new nodes at
 * the end of `order` (board order = creation order), and keep `active` a valid tab-mode tab
 * (nearest surviving non-Files tab, else the last one, else null). Pure; returns the SAME object
 * when nothing changed so React callers can bail out on identity.
 */
export function reconcileTabs(layout: TabLayout, nodes: readonly { id: string; kind: WsNodeKind }[]): TabLayout {
  const alive = new Set(nodes.map((n) => n.id))
  const tabIds = new Set(nodes.filter((n) => isTabKind(n.kind)).map((n) => n.id))
  const { order: old, active, filesPanel } = layout.tabs
  const kept = old.filter((id, i) => alive.has(id) && old.indexOf(id) === i)
  const order = [...kept, ...[...alive].filter((id) => !kept.includes(id))]
  const tabs = order.filter((id) => tabIds.has(id))
  const nextActive = active !== null && tabIds.has(active)
    ? active
    : nearestSurvivor(old, active, tabIds) ?? tabs[tabs.length - 1] ?? null
  const same = order.length === old.length && order.every((id, i) => id === old[i]) && nextActive === active
  return same ? layout : { ...layout, tabs: { order, active: nextActive, filesPanel } }
}
