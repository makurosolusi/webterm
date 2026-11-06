// Which node fills the canvas area, like VS Code "Maximize Editor Group": the node's host is moved
// into one overlay slot over the React Flow pane (nodeMaximize.overlay), never the OS full screen.
// View state only, never persisted: a reload starts restored and the node's position, size and the
// viewport are never touched. At most one node; maximizing another replaces it.
import { useSyncExternalStore } from 'react'
import { useNodeId } from '@xyflow/react'
import { useNodeHost } from './tabLayout.context'
import { getTabLayout } from './tabLayout.store'
import { nodeIdOf } from './nodeRoot'

let current: string | null = null
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

export const getMaximizedNode = (): string | null => current

/** Maximize `id` (null = restore). Same value = no-op. */
export function setMaximizedNode(id: string | null): void {
  if (id === current) return
  current = id
  listeners.forEach((l) => l())
}

export const toggleMaximizedNode = (id: string): void => setMaximizedNode(current === id ? null : id)

/** Command target: restore the maximized node, else maximize the focused node, else the sole selected one. Tab mode = no-op. */
export function toggleMaximizeTarget(nodes: readonly { id: string; selected?: boolean }[]): void {
  if (getTabLayout().mode === 'tabs') return
  const selected = nodes.filter((n) => n.selected)
  const id = current ?? nodeIdOf(document.activeElement) ?? (selected.length === 1 ? selected[0].id : undefined)
  if (id) toggleMaximizedNode(id)
}

/** React hook: the maximized node id, re-rendering on change. */
export const useMaximizedNode = (): string | null => useSyncExternalStore(subscribe, getMaximizedNode)

/** Maximize state of the node this component renders in; `toggle` is undefined where it cannot apply (tab mode, outside a node). */
export function useNodeMaximize(): { maximized: boolean; toggle: (() => void) | undefined } {
  const id = useNodeId()
  const { inTab, maximized } = useNodeHost()
  return { maximized, toggle: id !== null && !inTab ? () => toggleMaximizedNode(id) : undefined }
}
