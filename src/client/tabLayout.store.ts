// In-memory view of the ACTIVE workspace's tab layout, same shape as keybindings.store: a module
// singleton read by React via useSyncExternalStore and written through a connected `persist`.
// App connects it to the active workspace (layout in, `(next) => ref.layout = next; scheduleSave()`
// out). Every action produces a new TabLayout only; nodes, edges and canvas positions are never
// passed in, so switching mode cannot touch them.
import { useSyncExternalStore } from 'react'
import { clampFilesPanelWidth, defaultTabLayout, isTabKind, normalizeTabLayout, reconcileTabs, type LayoutMode, type TabLayout } from '../shared/tabLayout.schema'
import type { WsNodeKind } from '../shared/workspace.shape'

let current: TabLayout = defaultTabLayout()
/** Ids in `order` that tab mode docks instead of showing as a tab (Files), from the last reconcile. */
let panels: ReadonlySet<string> = new Set()
let persist: ((next: TabLayout) => void) | null = null
const listeners = new Set<() => void>()

function commit(next: TabLayout): void {
  if (next === current) return
  current = next
  listeners.forEach((l) => l())
  persist?.(next)
}

/** Point the store at a workspace's layout and a writer (null = nothing to persist, e.g. tests). */
export function connectTabLayout(layout: TabLayout | undefined, write: ((next: TabLayout) => void) | null): void {
  current = normalizeTabLayout(layout)
  persist = write
  listeners.forEach((l) => l())
}

export const getTabLayout = (): TabLayout => current

export function setMode(mode: LayoutMode): void {
  if (mode !== current.mode) commit({ ...current, mode })
}

/** Tab mode's tabs: `order` without the docked panel nodes (Files). */
export const tabModeOrder = (): string[] => current.tabs.order.filter((id) => !panels.has(id))

/** Show a tab; ids that are not tab-mode tabs are ignored. */
export function activateTab(id: string): void {
  const { tabs } = current
  if (tabs.active !== id && tabs.order.includes(id) && !panels.has(id)) commit({ ...current, tabs: { ...tabs, active: id } })
}

/** Reorder tabs. `order` may be a subset (tab mode leaves Files out; a stale drag misses ids):
 *  the listed known ids fill, in the new order, the slots they held; every other id stays put. */
export function reorderTabs(order: readonly string[]): void {
  const { tabs } = current
  const known = new Set(tabs.order)
  const moved = [...new Set(order.filter((id) => known.has(id)))]
  const slots = new Set(moved)
  let k = 0
  const next = tabs.order.map((id) => (slots.has(id) ? moved[k++] : id))
  if (next.some((id, i) => id !== tabs.order[i])) commit({ ...current, tabs: { ...tabs, order: next } })
}

/** Reconcile `order`/`active` with the board's nodes (both strips call this on every node change). */
export function reconcileWithNodes(nodes: readonly { id: string; kind: WsNodeKind }[]): void {
  panels = new Set(nodes.filter((n) => !isTabKind(n.kind)).map((n) => n.id))
  commit(reconcileTabs(current, nodes))
}

export function setFilesPanelWidth(width: number): void {
  const { tabs } = current
  const w = clampFilesPanelWidth(width)
  if (w !== tabs.filesPanel.width) commit({ ...current, tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, width: w } } })
}

/** Open or close the Files side panel; same value = no-op. */
export function setFilesPanelOpen(open: boolean): void {
  const { tabs } = current
  if (tabs.filesPanel.open !== open) commit({ ...current, tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, open } } })
}

export function toggleFilesPanel(): void {
  const { tabs } = current
  commit({ ...current, tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, open: !tabs.filesPanel.open } } })
}

/** React hook: the current layout, re-rendering on change. */
export function useTabLayout(): TabLayout {
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), getTabLayout)
}
