// Hiding a browser node = collapsing it: its session detaches, the server marks it paused and the next attach may take its
// live slot (BrowserLifecycle.admit evicts the oldest hidden node). Shared by the node's own collapse button and by the
// "Hide another browser…" list of a node the MAX_LIVE gate refused.
import type { Node, ReactFlowInstance } from '@xyflow/react'
import { hostOnly } from '../shared/browser.url'

export const COLLAPSED_H = 40
export const DEFAULT_H = 400
const BROWSER_NODE_TYPE = 'browser'

/** Height a node had before it was collapsed, by node id (the node's own ref cannot be reached from another node). */
const expanded = new Map<string, number>()

export const rememberHeight = (id: string, h: number): void => { expanded.set(id, h) }
/** The height to restore on expand (once); undefined = never collapsed through here. */
export const takeHeight = (id: string): number | undefined => { const h = expanded.get(id); expanded.delete(id); return h }

export interface HideCandidate { id: string; label: string }

const dataOf = (n: Node): { title?: string; name?: string; url?: string; collapsed?: boolean } => n.data as { title?: string; name?: string; url?: string; collapsed?: boolean }

/** Other browser nodes of the board that are showing (not collapsed): the ones that hold a live slot. */
export function hideCandidates(nodes: readonly Node[], selfId: string): HideCandidate[] {
  return nodes
    .filter((n) => n.type === BROWSER_NODE_TYPE && n.id !== selfId && !dataOf(n).collapsed)
    .map((n) => {
      const d = dataOf(n)
      const host = d.url ? hostOnly(d.url) : ''
      return { id: n.id, label: [d.title || d.name || 'Browser', host].filter(Boolean).join(' · ') }
    })
}

/** Collapse a browser node, remembering its height so expanding it later restores the size. */
export function hideBrowserNode(rf: ReactFlowInstance, id: string): void {
  const n = rf.getNode(id)
  if (!n || dataOf(n).collapsed) return
  rememberHeight(id, n.height ?? n.measured?.height ?? DEFAULT_H)
  rf.updateNode(id, { height: COLLAPSED_H })
  rf.updateNodeData(id, { collapsed: true })
}
