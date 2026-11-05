// Which node is in layout-edit (resize) mode. Client-only and never persisted: resizing is a
// deliberate, short-lived mode, so a reload or a workspace switch always starts with it off.
// One node at a time; same module-store pattern as commandRegistry.ts (useSyncExternalStore).
import { useSyncExternalStore } from 'react'

export interface NodeResizeState {
  /** Node whose resize handles are shown, or null. */
  editingId: string | null
  /** Dock "View locked": resizing is off while it is on. */
  locked: boolean
}

let state: NodeResizeState = { editingId: null, locked: false }
const listeners = new Set<() => void>()
const set = (next: Partial<NodeResizeState>): void => {
  const merged = { ...state, ...next }
  if (merged.editingId === state.editingId && merged.locked === state.locked) return
  state = merged
  listeners.forEach((l) => l())
}

export const getNodeResizeState = (): NodeResizeState => state
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
/** Live resize state. */
export const useNodeResizeState = (): NodeResizeState => useSyncExternalStore(subscribe, getNodeResizeState)

/** Turns resize mode on for `id` (off when it already is); a no-op while the view is locked. */
export function toggleNodeResize(id: string): void {
  if (state.locked) return
  set({ editingId: state.editingId === id ? null : id })
}

/** Leaves resize mode; with `id`, only if that node is the one in it. */
export function exitNodeResize(id?: string): void {
  if (id === undefined || state.editingId === id) set({ editingId: null })
}

/** Mirrors the Dock lock; locking also ends any open resize mode. */
export function setNodeResizeLocked(locked: boolean): void {
  set(locked ? { locked, editingId: null } : { locked })
}

/**
 * The "Node: Resize Focused Node" command: the node holding keyboard focus, else the single
 * selected node. Nothing to resize (none or several selected) does nothing.
 */
export function toggleFocusedNodeResize(selectedIds: readonly string[]): void {
  const focused = document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id')
  const id = focused ?? (selectedIds.length === 1 ? selectedIds[0] : undefined)
  if (id) toggleNodeResize(id)
}

export const RESIZE_COMMAND_ID = 'node.resizeFocused'
