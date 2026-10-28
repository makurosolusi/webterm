import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, applyEdgeChanges, addEdge, MarkerType } from '@xyflow/react'
import type { Node, NodeChange, Edge, EdgeChange, Connection, ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode from './TerminalNode'
import AgentNode from './AgentNode'
import ContextEdge from './ContextEdge'
import WorkspaceBar from './WorkspaceBar'
import Dock from './Dock'
import Kanban from './Kanban'
import FolderPicker from './FolderPicker'
import Welcome from './Welcome'
import { toFlow, toWsNode, toFlowEdge, toBridge, addNode, workspaceNameFromPath } from './store'
import { canLink, bridgeExists, hiddenEdgeNodeIds, edgeVisible } from './floatingEdge'
import { createHistory } from './history'
import { send, subscribeStatus } from './ws'
import { fetchWorkspaces, getActive, setActive, getWorkspace, createWorkspace, saveWorkspace } from './api'
import { AGENTS, DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentId, AgentStatus, Viewport, Workspace, WsNode } from '../shared/workspace'

const nodeTypes = { terminal: TerminalNode, agent: AgentNode }
const edgeTypes = { context: ContextEdge }

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeWs, setActiveWs] = useState<Workspace | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [board, setBoard] = useState(false)
  const [picker, setPicker] = useState<{ onPick: (p: string) => void } | null>(null)
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.zoom)

  const activeWsRef = useRef<Workspace | null>(null)
  const nodesRef = useRef<Node[]>([])
  const edgesRef = useRef<Edge[]>([])
  const viewportRef = useRef<Viewport>(DEFAULT_VIEWPORT)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rf = useRef<ReactFlowInstance | null>(null)

  const nodeHist = useRef(createHistory<Node[]>())
  const vpHist = useRef(createHistory<Viewport>())
  const [, bump] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    const unsub = subscribeStatus((id, s) => setStatuses((prev) => ({ ...prev, [id]: s })))
    return unsub
  }, [])

  const applyWorkspace = useCallback((ws: Workspace) => {
    setActiveWs(ws)
    activeWsRef.current = ws
    const vp = ws.viewport ?? DEFAULT_VIEWPORT
    viewportRef.current = vp
    setZoom(vp.zoom)
    const flow = ws.nodes.map(toFlow)
    nodesRef.current = flow
    setNodes(flow)
    const fe = (ws.bridges ?? []).map(toFlowEdge)
    edgesRef.current = fe
    setEdges(fe)
    nodeHist.current = createHistory<Node[]>()
    vpHist.current = createHistory<Viewport>()
    nodeHist.current.push(flow)
    vpHist.current.push(vp)
    bump()
  }, [])

  const loadWorkspace = useCallback(async (id: string) => {
    applyWorkspace(await getWorkspace(id))
  }, [applyWorkspace])

  useEffect(() => {
    void (async () => {
      const [list, active] = await Promise.all([fetchWorkspaces(), getActive()])
      setWorkspaces(list)
      let id = active
      if (!id && list.length) { id = list[0].id; await setActive(id) }
      if (id) { setActiveId(id); await loadWorkspace(id) }
    })()
  }, [loadWorkspace])

  const scheduleSave = useCallback(() => {
    const ws = activeWsRef.current
    if (!ws) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const updated: Workspace = { ...ws, nodes: nodesRef.current.map(toWsNode), bridges: edgesRef.current.map(toBridge), viewport: viewportRef.current, updatedAt: Date.now() }
      activeWsRef.current = updated
      void saveWorkspace(updated)
    }, 400)
  }, [])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((prev) => {
      const next = applyNodeChanges(changes, prev)
      nodesRef.current = next
      if (changes.some((c) => c.type === 'remove')) {
        for (const c of changes) if (c.type === 'remove') send({ t: 'close', id: c.id })
      }
      const settled = changes.some(
        (c) => (c.type === 'position' && !c.dragging) || c.type === 'remove' || (c.type === 'dimensions' && !c.resizing),
      )
      if (settled) {
        scheduleSave()
        nodeHist.current.push(next)
        bump()
      } else if (changes.some((c) => c.type === 'replace')) {
        // Data-only change (collapse/color/rename/comments/hideLinks via updateNodeData):
        // persist but DON'T push to layout history — mirrors onSession.
        scheduleSave()
      }
      return next
    })
  }, [scheduleSave])

  const onMoveEnd = useCallback((_e: unknown, vp: Viewport) => {
    viewportRef.current = vp
    setZoom(vp.zoom)
    vpHist.current.push(vp)
    bump()
    scheduleSave()
  }, [scheduleSave])

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return
    const src = nodesRef.current.find((n) => n.id === c.source)
    const tgt = nodesRef.current.find((n) => n.id === c.target)
    const sa = (src?.data as { agentId?: AgentId })?.agentId
    const ta = (tgt?.data as { agentId?: AgentId })?.agentId
    if (!canLink(sa, ta, c.source, c.target)) return
    if (bridgeExists(edgesRef.current, c.source, c.target)) return
    setEdges((es) => {
      const next = addEdge({ id: `bridge-${c.source}-${c.target}`, source: c.source!, target: c.target!, type: 'context' }, es)
      edgesRef.current = next
      return next
    })
    scheduleSave()
  }, [scheduleSave])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((prev) => {
      const next = applyEdgeChanges(changes, prev)
      edgesRef.current = next
      if (changes.some((c) => c.type === 'remove')) scheduleSave()
      return next
    })
  }, [scheduleSave])

  const addFlowNode = useCallback((make: (n: number, ws: Workspace) => WsNode) => {
    const ws = activeWsRef.current
    if (!ws) return
    setNodes((prev) => {
      const node = make(prev.length, ws)
      const next = addNode(prev.map(toWsNode), node).map(toFlow)
      nodesRef.current = next
      scheduleSave()
      nodeHist.current.push(next)
      bump()
      return next
    })
  }, [scheduleSave])

  const onAddTerminal = useCallback(() => {
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'terminal', x: 80 + n * 40, y: 80 + n * 40, cwd: ws.cwd }))
  }, [addFlowNode])

  const onAddAgent = useCallback((cmd: string, agentId: AgentId, cwd?: string) => {
    const color = agentId !== 'custom' ? AGENTS[agentId].color : undefined
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'agent', x: 80 + n * 40, y: 80 + n * 40, cmd, agentId, cwd: cwd ?? ws.cwd, color, sessionId: crypto.randomUUID() }))
  }, [addFlowNode])

  // A node minted its own session uuid (or restarted): persist it to that node.
  // Data-only change — not pushed to layout history (undo must not drop a live session id).
  const onSession = useCallback((nodeId: string, uuid: string) => {
    setNodes((prev) => {
      const next = prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, sessionId: uuid } } : n))
      nodesRef.current = next
      scheduleSave()
      return next
    })
  }, [scheduleSave])

  const onFocus = useCallback((id: string) => {
    const node = nodesRef.current.find((n) => n.id === id)
    if (!node) return
    rf.current?.setCenter(node.position.x + 240, node.position.y + 160, { zoom: 1, duration: 400 })
    setBoard(false)
  }, [])

  const onSelect = useCallback(async (id: string) => {
    if (!id || id === activeId) return
    await setActive(id)
    setActiveId(id)
    await loadWorkspace(id)
  }, [activeId, loadWorkspace])

  const onCreateWorkspace = useCallback(async (name: string, cwd?: string) => {
    const ws = await createWorkspace(name, cwd)
    setWorkspaces((prev) => [...prev, ws])
    await setActive(ws.id)
    setActiveId(ws.id)
    applyWorkspace(ws)
  }, [applyWorkspace])

  const onNewProject = useCallback(() => {
    setPicker({ onPick: (p: string) => void onCreateWorkspace(workspaceNameFromPath(p), p) })
  }, [onCreateWorkspace])

  // Programmatic viewport moves (setViewport/zoomIn/fitView) mark sourceEvent.internal,
  // so onMoveEnd does NOT fire for them — sync the readout + persist after the animation.
  const syncViewport = useCallback((delay: number) => {
    setTimeout(() => {
      const vp = rf.current?.getViewport()
      if (vp) { viewportRef.current = vp; setZoom(vp.zoom); scheduleSave() }
    }, delay)
  }, [scheduleSave])

  const onUndo = useCallback(() => {
    const s = nodeHist.current.undo()
    if (s) { nodesRef.current = s; setNodes(s); scheduleSave() }
    bump()
  }, [scheduleSave])

  const onRedo = useCallback(() => {
    const s = nodeHist.current.redo()
    if (s) { nodesRef.current = s; setNodes(s); scheduleSave() }
    bump()
  }, [scheduleSave])

  const onBack = useCallback(() => {
    const v = vpHist.current.undo()
    if (v) { viewportRef.current = v; rf.current?.setViewport(v, { duration: 300 }); setZoom(v.zoom); scheduleSave() }
    bump()
  }, [scheduleSave])

  const onForward = useCallback(() => {
    const v = vpHist.current.redo()
    if (v) { viewportRef.current = v; rf.current?.setViewport(v, { duration: 300 }); setZoom(v.zoom); scheduleSave() }
    bump()
  }, [scheduleSave])

  const nodeColor = useCallback((n: Node) => {
    if (n.type === 'terminal') return '#0a84ff'
    const s = statuses[n.id]
    if (s === 'working') return '#d97757'
    if (s === 'waiting') return '#ff9f0a'
    if (s === 'blocked') return '#ff453a'
    if (s === 'done') return '#98989d'
    return ((n.data as { color?: string }).color) ?? '#0a84ff'
  }, [statuses])

  const onToggleHideLinks = useCallback((id: string) => {
    const cur = nodesRef.current.find((n) => n.id === id)
    rf.current?.updateNodeData(id, { hideLinks: !(cur?.data as { hideLinks?: boolean })?.hideLinks })
  }, [])

  // Inject onSession + hideLinks eye handler into agent nodes for rendering only;
  // toWsNode drops the handlers, so saves are unaffected. Derived to keep state clean.
  const flowNodes = useMemo(
    () => nodes.map((n) => (n.type === 'agent'
      ? { ...n, data: { ...n.data, onSession, hideLinks: (n.data as { hideLinks?: boolean }).hideLinks, onToggleHideLinks: () => onToggleHideLinks(n.id) } }
      : n)),
    [nodes, onSession, onToggleHideLinks],
  )

  const displayEdges = useMemo<Edge[]>(() => {
    const hidden = hiddenEdgeNodeIds(nodes as { id: string; data: { hideLinks?: boolean } }[])
    const accent = '#0a84ff'
    return edges.filter((e) => edgeVisible(e, hidden)).map((e) => {
      const stroke = e.selected ? '#ffffff' : accent
      const arrow = { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 }
      return { ...e, data: { anchor: 'horizontal' },
        label: e.selected ? '⇄ context — ⌫ to remove' : '⇄ context',
        labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
        style: { stroke, strokeWidth: e.selected ? 3.5 : 2 },
        markerStart: arrow, markerEnd: arrow }
    })
  }, [edges, nodes])

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      {workspaces.length === 0 ? (
        <Welcome onNewProject={onNewProject} onCreateEmpty={(name) => void onCreateWorkspace(name)} />
      ) : (
        <>
          <WorkspaceBar workspaces={workspaces} activeId={activeId} onSelect={onSelect} />
          <ReactFlow
            key={activeId ?? 'empty'}
            nodes={flowNodes}
            nodeTypes={nodeTypes}
            edges={displayEdges}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeDoubleClick={(_, e) => { void rf.current?.deleteElements({ edges: [{ id: e.id }] }) }}
            onMoveEnd={onMoveEnd}
            onInit={(i) => (rf.current = i)}
            defaultViewport={activeWs?.viewport ?? DEFAULT_VIEWPORT}
            fitView={false}
            minZoom={0.01}
            maxZoom={2}
            snapToGrid
            snapGrid={[24, 24]}
            panOnScroll
            zoomOnScroll={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={2.5} color="var(--canvas-dot)" />
            <MiniMap className="minimap-dock" pannable zoomable maskColor="rgba(10,12,18,0.6)" nodeColor={nodeColor} />
          </ReactFlow>
          <Dock
            onAddTerminal={onAddTerminal}
            onAddAgent={onAddAgent}
            onCreateWorkspace={onCreateWorkspace}
            onBrowse={(onPick) => setPicker({ onPick })}
            onUndo={onUndo}
            onRedo={onRedo}
            canUndo={nodeHist.current.canUndo()}
            canRedo={nodeHist.current.canRedo()}
            onBack={onBack}
            onForward={onForward}
            canBack={vpHist.current.canUndo()}
            canForward={vpHist.current.canRedo()}
            onFit={() => { rf.current?.fitView({ duration: 300 }); syncViewport(320) }}
            onToggleBoard={() => setBoard((v) => !v)}
            zoomPct={Math.round(zoom * 100)}
            onZoomIn={() => { rf.current?.zoomIn({ duration: 150 }); syncViewport(170) }}
            onZoomOut={() => { rf.current?.zoomOut({ duration: 150 }); syncViewport(170) }}
          />
          {board && <Kanban nodes={flowNodes} statuses={statuses} onFocus={onFocus} onClose={() => setBoard(false)} />}
        </>
      )}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
    </div>
  )
}
