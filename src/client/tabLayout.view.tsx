// Tab mode body (Orca layout): tab strip on top, below it [active tab | Files panel]. Every tab
// node keeps a pane for its whole life; only the active pane is displayed, the others are
// display:none so hosts (xterm, iframes) are never detached or re-created.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Node } from '@xyflow/react'
import type { AgentStatus, WsNode, WsNodeKind } from '../shared/workspace'
import { isTabKind } from '../shared/tabLayout.schema'
import { IconButton } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { KIND_ICON, nodeRowLabel } from './nodeList'
import { parkNodeHost, placeNodeHost } from './tabLayout.dom'
import { activateTab, reconcileWithNodes, reorderTabs, setMode, toggleFilesPanel, useTabLayout } from './tabLayout.store'
import { nodeTabSignal } from './sessionSignal'
import { useUnreadIds } from './unread'
import TabStrip, { type TabItem } from './tabLayout.strip'
import FilesDock from './tabLayout.filesDock'
import NewTabMenu, { type NewTabMenuProps } from './tabLayout.newMenu'
import './tab-layout.css'

export interface TabsViewProps extends NewTabMenuProps {
  /** Flow nodes of the board; `type` is the WsNodeKind, `data` mirrors WsNode. */
  nodes: Node[]
  statuses: Record<string, AgentStatus>
  onCloseNode: (id: string) => void
  onRenameNode: (id: string, title: string) => void
}

const kindOf = (n: Node): WsNodeKind => (n.type as WsNodeKind | undefined) ?? 'terminal'
const titleOf = (n: Node): string => nodeRowLabel({ ...(n.data as Partial<WsNode>), id: n.id, kind: kindOf(n) } as WsNode)

function TabPane({ id, active }: { id: string; active: boolean }) {
  // Ref detach runs in React's mutation phase before the pane leaves the DOM, so parking keeps the host connected.
  const ref = useCallback((el: HTMLDivElement | null) => { if (el) placeNodeHost(id, el); else parkNodeHost(id) }, [id])
  // tabIndex lets the shortcut layer hand keyboard focus to the visible tab.
  return <div ref={ref} className="tabs-pane" data-tab-node="" data-id={id} style={{ display: active ? undefined : 'none' }} tabIndex={active ? -1 : undefined} />
}

export default function TabsView(p: TabsViewProps) {
  const { nodes } = p
  const { order, active, filesPanel } = useTabLayout().tabs
  const unread = useUnreadIds()

  // Keep order/active in line with the nodes; a node that appears next to existing ones becomes the active tab (Orca opens new tabs focused).
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    const kinds = nodes.map((n) => ({ id: n.id, kind: kindOf(n) }))
    reconcileWithNodes(kinds)
    const ids = new Set(kinds.filter((k) => isTabKind(k.kind)).map((k) => k.id))
    const prev = seen.current
    seen.current = ids
    // Disjoint sets = another board was loaded, not a node added: keep its persisted active tab.
    if (!prev || ![...ids].some((id) => prev.has(id))) return
    const added = [...ids].filter((id) => !prev.has(id))
    if (added.length) activateTab(added[added.length - 1])
  }, [nodes])

  // Panes stay in first-seen order, not tab order: re-ordering DOM siblings would reload iframes.
  const paneIds = useRef<string[]>([])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  // Files nodes are in `order` too (canvas strip) but are docked here, not tabs.
  const live = new Set(order.filter((id) => { const n = byId.get(id); return !!n && isTabKind(kindOf(n)) }))
  paneIds.current = [...paneIds.current.filter((id) => live.has(id)), ...order.filter((id) => live.has(id) && !paneIds.current.includes(id))]

  const items: TabItem[] = order.filter((id) => live.has(id)).map((id) => {
    const n = byId.get(id) as Node
    return { id, title: titleOf(n), name: (n.data as Partial<WsNode>).name, icon: KIND_ICON[kindOf(n)], signal: nodeTabSignal(kindOf(n), p.statuses[id], unread.has(id)) }
  })
  const filesId = nodes.find((n) => kindOf(n) === 'files')?.id ?? null

  return (
    <div className="tabs-view">
      <TabStrip items={items} active={active} onActivate={activateTab} onClose={p.onCloseNode} onRename={p.onRenameNode} onReorder={reorderTabs}>
        <NewTabMenu {...p} />
        <IconButton
          label="Files panel" tooltip={filesPanel.open ? 'Hide Files panel' : 'Show Files panel'} side="bottom" size="icon-sm"
          aria-pressed={filesPanel.open} onClick={toggleFilesPanel}
        ><span className={cn('codicon', filesPanel.open ? 'codicon-layout-sidebar-right' : 'codicon-layout-sidebar-right-off')} aria-hidden="true" /></IconButton>
        <IconButton label="Back to canvas" side="bottom" size="icon-sm" onClick={() => setMode('canvas')}>
          <span className="codicon codicon-graph" aria-hidden="true" />
        </IconButton>
      </TabStrip>
      <div className="tabs-body">
        <div className="tabs-area">
          {paneIds.current.map((id) => <TabPane key={id} id={id} active={id === active} />)}
          {items.length === 0 && (
            <div className="tabs-empty">
              <p>No tabs open.</p>
              <div className="tabs-empty__actions">
                <Button size="sm" onClick={p.onAddTerminal}>New Terminal</Button>
                <Button size="sm" variant="secondary" onClick={p.onAddAgent}>New Agent</Button>
              </div>
            </div>
          )}
        </div>
        <FilesDock filesId={filesId} open={filesPanel.open} width={filesPanel.width} onAddFiles={p.onAddFiles} />
      </div>
    </div>
  )
}
