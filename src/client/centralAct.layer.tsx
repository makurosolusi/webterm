// Glue between the act record and the board: marks touched nodes/cables, draws their chips, and hosts the tray.
// Camera: the user's click on Show, or Follow (centralFollow.ts: ON by default, pauses when the user moves the canvas).
// Neither touches the user's selection from Follow; an act frame itself (store, chips, tray) never moves anything.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ViewportPortal, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import type { RefObject } from 'react'
import { useInRouterContext } from 'react-router'
import { fetchWorkspaces } from './api'
import { useAppRoute } from './appRoute'
import { CentralActTray } from './CentralActTray'
import { isCableVerb, isNewVerb, setShowNodeHandler, useCentralAct, type ActEntry } from './centralAct.store'
import { useCentralFollow } from './centralFollow'
import { rectOfNode, revealNode, selectOnly } from './nodeReveal'
import './centralAct.css'

export const TOUCHED_CLASS = 'nt-touched'
export const CABLE_ACTIVE_CLASS = 'nt-cable-active'
const withClass = (cur: string | undefined, add: string): string => (cur ? `${cur} ${add}` : add)

/** `nodes`/`edges` with the touched ones classed; untouched objects keep their identity (React Flow memoises on it). Same arrays when nothing is touched. */
export function markTouched(nodes: Node[], edges: Edge[], entries: readonly ActEntry[]): { nodes: Node[]; edges: Edge[] } {
  if (entries.length === 0) return { nodes, edges }
  const touched = new Set(entries.map((e) => e.nodeId))
  const cable = new Set(entries.filter((e) => isCableVerb(e.verb)).flatMap((e) => (e.nodeId2 ? [e.nodeId, e.nodeId2] : [e.nodeId])))
  return {
    nodes: nodes.map((n) => (touched.has(n.id) ? { ...n, className: withClass(n.className, TOUCHED_CLASS) } : n)),
    edges: cable.size === 0 ? edges : edges.map((e) => (cable.has(e.source) || cable.has(e.target) ? { ...e, className: withClass(e.className, CABLE_ACTIVE_CLASS) } : e)),
  }
}

const titleOf = (n: Node): string => {
  const d = n.data as { title?: string; name?: string } | undefined
  return d?.title || d?.name || n.id
}

/** "Central · just now" above each touched node; "New" for one Central just created. Decoration only (the tray speaks). */
function ActChips({ nodes, entries }: { nodes: readonly Node[]; entries: readonly ActEntry[] }): React.JSX.Element {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  return (
    <ViewportPortal>
      {entries.flatMap((e) => {
        const n = byId.get(e.nodeId)
        // ponytail: node.position is relative to its parent; nodes inside a group chip at the wrong spot. Use positionAbsolute if grouping nests nodes.
        if (!n || e.verb === 'closed') return []
        const fresh = isNewVerb(e.verb)
        return [(
          <div key={e.nodeId} className="central-act-chip" data-new={fresh} aria-hidden="true" style={{ left: n.position.x, top: n.position.y }}>
            {fresh ? 'New' : 'Central · just now'}
          </div>
        )]
      })}
    </ViewportPortal>
  )
}

/** Board names, fetched once the first time an act points at another board. */
function useBoardNames(needed: boolean): (id: string) => string | undefined {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    if (!needed) return
    let live = true
    fetchWorkspaces()
      .then((list) => { if (live) setNames(new Map(list.map((w) => [w.id, w.name]))) })
      .catch((err: unknown) => { console.warn('central.act: could not load board names', err instanceof Error ? err.message : 'unknown') })
    return () => { live = false }
  }, [needed])
  return (id) => names.get(id)
}

interface LayerProps {
  rf: RefObject<ReactFlowInstance | null>
  nodes: readonly Node[]
  workspaceId: string | null
  /** Switch to another board; absent outside a router (isolated renders). */
  onOpenBoard?: (workspaceId: string) => void
}

/** Chips + tray. Mount inside <ReactFlow>. */
export function CentralActLayer({ rf, nodes, workspaceId, onOpenBoard }: LayerProps): React.JSX.Element {
  const { entries, dropped } = useCentralAct()
  const here = useMemo(() => new Map(nodes.map((n) => [n.id, titleOf(n)])), [nodes])
  const latest = entries[0]
  const { view: follow, setOn: setFollow } = useCentralFollow(rf, entries, workspaceId)
  const foreign = !!latest && !here.has(latest.nodeId) && !!latest.workspaceId && latest.workspaceId !== workspaceId
  const boardName = useBoardNames(foreign)
  // Over .app-main (it stays visible in tab mode, unlike the hidden canvas); body in isolated renders.
  const [host, setHost] = useState<Element | null>(null)
  useEffect(() => setHost(document.querySelector('.app-main') ?? document.body), [])
  const show = (id: string): boolean => {
    const n = rf.current?.getNode(id)
    if (!n || !rf.current) return false
    revealNode(rf.current, id, rectOfNode(n), { focus: true, zoomToReadable: true })
    selectOnly(rf.current, id)
    return true
  }
  const showRef = useRef(show)
  showRef.current = show
  useEffect(() => { setShowNodeHandler((id) => showRef.current(id)); return () => setShowNodeHandler(null) }, [])
  return (
    <>
      <ActChips nodes={nodes} entries={entries} />
      {host && createPortal(
        <CentralActTray
          entries={entries} dropped={dropped} activeWorkspaceId={workspaceId} nodeTitle={(id) => here.get(id)} boardName={boardName}
          follow={follow} onToggleFollow={() => setFollow(!follow.on)} onShow={(id) => { show(id) }} onOpenBoard={(id) => onOpenBoard?.(id)}
        />, host,
      )}
    </>
  )
}

function RoutedLayer(props: Omit<LayerProps, 'onOpenBoard'>): React.JSX.Element {
  const { actions } = useAppRoute()
  return <CentralActLayer {...props} onOpenBoard={(id) => actions.goWorkspace(id)} />
}

/** The mount BoardCanvas uses: board switching goes through the URL when a router exists. */
export default function CentralActMount(props: Omit<LayerProps, 'onOpenBoard'>): React.JSX.Element {
  return useInRouterContext() ? <RoutedLayer {...props} /> : <CentralActLayer {...props} />
}
