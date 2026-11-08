// Node tab strip above the canvas (canvas mode): the shared TabStrip with one tab per node of the
// open board. Click = select + reveal + focus the node; the tab of the selected node is the active
// one. Order is the workspace layout's `tabs.order` (persisted with the workspace; tab mode uses
// the same list minus Files), so both layouts show the nodes in the same order. Status dots come
// from `nodeTabSignal`, the selector behind the Sessions side bar glyph.
import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import type { AgentStatus, WsNode, WsNodeKind } from '../shared/workspace'
import { isTabKind } from '../shared/tabLayout.schema'
import { KIND_ICON, nodeRowLabel } from './nodeList'
import { rectOfNode, revealNode, selectOnly } from './nodeReveal'
import { activateTab, reconcileWithNodes, reorderTabs, useTabLayout } from './tabLayout.store'
import { nodeTabSignal } from './sessionSignal'
import { useUnreadIds } from './unread'
import TabStrip, { type TabItem } from './tabLayout.strip'

export interface NodeTabsProps {
  nodes: Node[]
  statuses: Record<string, AgentStatus>
  rf: RefObject<ReactFlowInstance | null>
  onCloseNode: (id: string) => void
  onRenameNode: (id: string, title: string) => void
}

const kindOf = (n: Node): WsNodeKind => (n.type as WsNodeKind | undefined) ?? 'terminal'

/** Tabs in strip order: `order` first, then nodes it does not hold yet (before the first reconcile) in board order. */
export function nodeTabItems(
  nodes: readonly Node[], order: readonly string[], statuses: Record<string, AgentStatus>, unread: ReadonlySet<string> = new Set(),
): TabItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ids = [...order.filter((id) => byId.has(id)), ...nodes.map((n) => n.id).filter((id) => !order.includes(id))]
  return ids.map((id) => {
    const n = byId.get(id) as Node
    const kind = kindOf(n)
    return {
      id, icon: KIND_ICON[kind],
      title: nodeRowLabel({ ...(n.data as Partial<WsNode>), id, kind } as WsNode),
      signal: nodeTabSignal(kind, statuses[id], unread.has(id)),
    }
  })
}

export default function NodeTabs({ nodes, statuses, rf, onCloseNode, onRenameNode }: NodeTabsProps) {
  const { order } = useTabLayout().tabs
  // Same reconcile as tab mode: new nodes are appended (creation order), removed ones dropped.
  useEffect(() => {
    reconcileWithNodes(nodes.map((n) => ({ id: n.id, kind: kindOf(n) })))
  }, [nodes])

  const unread = useUnreadIds()
  const items = nodeTabItems(nodes, order, statuses, unread)
  const active = nodes.find((n) => n.selected)?.id ?? null
  const onActivate = (id: string) => {
    const r = rf.current
    const n = r?.getNode(id)
    if (!r || !n) return
    selectOnly(r, id)
    // Keeps tab mode on the same node when the user switches layouts.
    if (isTabKind(kindOf(n))) activateTab(id)
    revealNode(r, id, rectOfNode(n))
  }
  return (
    <div className="node-tabs nodrag">
      <TabStrip
        label="Nodes" items={items} active={active} onActivate={onActivate}
        onClose={onCloseNode} onRename={onRenameNode} onReorder={reorderTabs}
      />
    </div>
  )
}
