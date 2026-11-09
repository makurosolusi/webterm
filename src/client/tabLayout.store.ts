// In-memory view of the ACTIVE workspace's tab layout, same shape as keybindings.store: a module
// singleton read by React via useSyncExternalStore and written through a connected `persist`.
// App connects it to the active workspace (layout in, `(next) => ref.layout = next; scheduleSave()`
// out). Every action produces a new TabLayout only; nodes, edges and canvas positions are never
// passed in, so switching mode cannot touch them.
import { useSyncExternalStore } from 'react'
import {
  DEFAULT_TAB_GROUP_NAME, MAX_TAB_GROUPS, clampFilesPanelWidth, cleanGroupName, defaultTabLayout, isTabKind,
  normalizeTabLayout, packGroups, reconcileTabs, sameGroups, type LayoutMode, type TabGroup, type TabLayout,
} from '../shared/tabLayout.schema'
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

/** Commit a new `order`/`groups` pair with the group invariant restored (members contiguous);
 *  nothing is written when the result equals the current state. */
function commitTabs(order: readonly string[], groups: readonly TabGroup[]): void {
  const { tabs } = current
  const p = packGroups(order, groups)
  const same = p.order.length === tabs.order.length && p.order.every((id, i) => id === tabs.order[i]) && sameGroups(p.groups, tabs.groups)
  if (!same) commit({ ...current, tabs: { ...tabs, ...p } })
}

/** Reorder tabs. `order` may be a subset (tab mode leaves Files out; a stale drag misses ids):
 *  the listed known ids fill, in the new order, the slots they held; every other id stays put.
 *  A reorder that splits a group pulls its members back together. */
export function reorderTabs(order: readonly string[]): void {
  const { tabs } = current
  const known = new Set(tabs.order)
  const moved = [...new Set(order.filter((id) => known.has(id)))]
  const slots = new Set(moved)
  let k = 0
  commitTabs(tabs.order.map((id) => (slots.has(id) ? moved[k++] : id)), tabs.groups)
}

/** The group that holds node `id`, if any. Pure. */
export const groupOf = (layout: TabLayout, id: string): TabGroup | undefined => layout.tabs.groups.find((g) => g.ids.includes(id))

/** Lowest free "Group N" name (N >= 1). */
function nextGroupName(groups: readonly TabGroup[]): string {
  const used = new Set(groups.map((g) => g.name))
  let n = 1
  while (used.has(`${DEFAULT_TAB_GROUP_NAME} ${n}`)) n++
  return `${DEFAULT_TAB_GROUP_NAME} ${n}`
}

/** Group the given nodes (taken out of any other group), contiguous at the first member's slot.
 *  Returns the new group id, or null when no known id is given or the group cap is reached. */
export function createGroup(ids: readonly string[], name?: string): string | null {
  const { tabs } = current
  const known = new Set(tabs.order)
  const members = [...new Set(ids)].filter((id) => known.has(id))
  if (members.length === 0 || tabs.groups.length >= MAX_TAB_GROUPS) return null
  const taken = new Set(members)
  const id = `g-${crypto.randomUUID()}`
  const label = name?.trim() ? cleanGroupName(name) : nextGroupName(tabs.groups)
  const groups = tabs.groups.map((g) => ({ ...g, ids: g.ids.filter((m) => !taken.has(m)) }))
  commitTabs(tabs.order, [...groups, { id, name: label, collapsed: false, ids: members }])
  return id
}

/** Remove a group; its nodes stay where they are in `order`. */
export function ungroup(groupId: string): void {
  const { tabs } = current
  commitTabs(tabs.order, tabs.groups.filter((g) => g.id !== groupId))
}

/** Rename a group (trimmed, cut to MAX_TAB_GROUP_NAME); a blank name is ignored. */
export function renameGroup(groupId: string, name: string): void {
  if (!name.trim()) return
  const { tabs } = current
  commitTabs(tabs.order, tabs.groups.map((g) => (g.id === groupId ? { ...g, name: cleanGroupName(name) } : g)))
}

/** Collapse or expand a group; without `collapsed` it flips. */
export function toggleGroup(groupId: string, collapsed?: boolean): void {
  const { tabs } = current
  commitTabs(tabs.order, tabs.groups.map((g) => (g.id === groupId ? { ...g, collapsed: collapsed ?? !g.collapsed } : g)))
}

/**
 * Move node `id` into group `groupId` (null = top level) and place it before `beforeId`. A
 * `beforeId` outside the target is ignored, except at top level where it means "before the group
 * that holds it". Without a usable `beforeId` the node goes to the end of the group, or of the list;
 * into an EMPTY group it keeps its slot (an empty group has no position in `order`).
 */
export function moveToGroup(id: string, groupId: string | null, beforeId?: string | null): void {
  const { tabs } = current
  const target = groupId === null ? null : tabs.groups.find((g) => g.id === groupId)
  if (!tabs.order.includes(id) || target === undefined) return
  const groups = tabs.groups.map((g) => {
    const ids = g.ids.filter((m) => m !== id)
    return g === target ? { ...g, ids: [...ids, id] } : { ...g, ids }
  })
  const at = tabs.order.indexOf(id)
  const rest = tabs.order.filter((m) => m !== id)
  const before = beforeId && beforeId !== id && rest.includes(beforeId) ? beforeId : null
  const beforeGroup = before === null ? undefined : groupOf(current, before)
  let index: number
  if (before !== null && target !== null && beforeGroup === target) index = rest.indexOf(before)
  else if (before !== null && target === null) index = rest.indexOf(beforeGroup ? beforeGroup.ids.find((m) => m !== id) ?? before : before)
  else if (beforeId === id) index = at
  else if (target === null) index = rest.length
  else {
    const others = target.ids.filter((m) => m !== id)
    index = others.length ? rest.indexOf(others[others.length - 1]) + 1 : at
  }
  commitTabs([...rest.slice(0, index), id, ...rest.slice(index)], groups)
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
