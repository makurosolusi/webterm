// In-memory view of the ACTIVE workspace's tab layout, same shape as keybindings.store: a module
// singleton read by React via useSyncExternalStore and written through a connected `persist`.
// App connects it to the active workspace (layout in, `(next) => ref.layout = next; scheduleSave()`
// out). Every action produces a new TabLayout only; nodes, edges and canvas positions are never
// passed in, so switching mode cannot touch them.
import { useSyncExternalStore } from 'react'
import { clampFilesPanelWidth, defaultTabLayout, normalizeTabLayout, type LayoutMode, type TabLayout } from '../shared/tabLayout.schema'

let current: TabLayout = defaultTabLayout()
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

/** Show a tab; ids that are not in `order` are ignored. */
export function activateTab(id: string): void {
  const { tabs } = current
  if (tabs.active !== id && tabs.order.includes(id)) commit({ ...current, tabs: { ...tabs, active: id } })
}

/** Reorder tabs. Only a permutation of the current ids counts: unknown ids are dropped and
 *  missing ones keep their old relative position at the end, so a stale drag can't lose a tab. */
export function reorderTabs(order: readonly string[]): void {
  const { tabs } = current
  const known = new Set(tabs.order)
  const next = [...new Set(order.filter((id) => known.has(id)))]
  next.push(...tabs.order.filter((id) => !next.includes(id)))
  if (next.some((id, i) => id !== tabs.order[i])) commit({ ...current, tabs: { ...tabs, order: next } })
}

export function setFilesPanelWidth(width: number): void {
  const { tabs } = current
  const w = clampFilesPanelWidth(width)
  if (w !== tabs.filesPanel.width) commit({ ...current, tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, width: w } } })
}

export function toggleFilesPanel(): void {
  const { tabs } = current
  commit({ ...current, tabs: { ...tabs, filesPanel: { ...tabs.filesPanel, open: !tabs.filesPanel.open } } })
}

/** Store a layout produced by `reconcileTabs(getTabLayout(), nodes)`; same object back = no-op. */
export function applyReconciled(next: TabLayout): void {
  commit(next)
}

/** React hook: the current layout, re-rendering on change. */
export function useTabLayout(): TabLayout {
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), getTabLayout)
}
