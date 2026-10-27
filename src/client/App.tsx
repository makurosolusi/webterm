import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, applyNodeChanges } from '@xyflow/react'
import type { Node, NodeChange, ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import TerminalNode from './TerminalNode'
import AgentNode from './AgentNode'
import WorkspaceBar from './WorkspaceBar'
import Kanban from './Kanban'
import FolderPicker from './FolderPicker'
import { toFlow, toWsNode, addNode } from './store'
import { send, subscribeStatus } from './ws'
import { fetchWorkspaces, getActive, setActive, getWorkspace, createWorkspace, saveWorkspace } from './api'
import { AGENTS, DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentId, AgentStatus, Viewport, Workspace, WsNode } from '../shared/workspace'

const nodeTypes = { terminal: TerminalNode, agent: AgentNode }

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeWs, setActiveWs] = useState<Workspace | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [board, setBoard] = useState(false)
  const [picker, setPicker] = useState<{ onPick: (p: string) => void } | null>(null)

  const activeWsRef = useRef<Workspace | null>(null)
  const nodesRef = useRef<Node[]>([])
  const viewportRef = useRef<Viewport>(DEFAULT_VIEWPORT)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rf = useRef<ReactFlowInstance | null>(null)

  useEffect(() => {
    const unsub = subscribeStatus((id, s) => setStatuses((prev) => ({ ...prev, [id]: s })))
    return unsub
  }, [])

  const applyWorkspace = useCallback((ws: Workspace) => {
    setActiveWs(ws)
    activeWsRef.current = ws
    viewportRef.current = ws.viewport ?? DEFAULT_VIEWPORT
    const flow = ws.nodes.map(toFlow)
    nodesRef.current = flow
    setNodes(flow)
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
      const updated: Workspace = { ...ws, nodes: nodesRef.current.map(toWsNode), viewport: viewportRef.current, updatedAt: Date.now() }
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
      const settled = changes.some((c) => (c.type === 'position' && !c.dragging) || c.type === 'remove')
      if (settled) scheduleSave()
      return next
    })
  }, [scheduleSave])

  const onMoveEnd = useCallback((_e: unknown, vp: Viewport) => {
    viewportRef.current = vp
    scheduleSave()
  }, [scheduleSave])

  const addFlowNode = useCallback((make: (n: number, ws: Workspace) => WsNode) => {
    const ws = activeWsRef.current
    if (!ws) return
    setNodes((prev) => {
      const node = make(prev.length, ws)
      const next = addNode(prev.map(toWsNode), node).map(toFlow)
      nodesRef.current = next
      scheduleSave()
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

  // Inject onSession into agent nodes for rendering only; toWsNode drops it, so
  // saves are unaffected. Derived (not mutated) to keep persisted state clean.
  const flowNodes = useMemo(
    () => nodes.map((n) => (n.type === 'agent' ? { ...n, data: { ...n.data, onSession } } : n)),
    [nodes, onSession],
  )

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111' }}>
      <WorkspaceBar
        workspaces={workspaces}
        activeId={activeId}
        onSelect={onSelect}
        onCreateWorkspace={onCreateWorkspace}
        onAddTerminal={onAddTerminal}
        onAddAgent={onAddAgent}
        onToggleBoard={() => setBoard((v) => !v)}
        onBrowse={(onPick) => setPicker({ onPick })}
      />
      <ReactFlow
        key={activeId ?? 'empty'}
        nodes={flowNodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onMoveEnd={onMoveEnd}
        onInit={(i) => (rf.current = i)}
        defaultViewport={activeWs?.viewport ?? DEFAULT_VIEWPORT}
        fitView={false}
      >
        <Background />
        <Controls />
      </ReactFlow>
      {board && <Kanban nodes={flowNodes} statuses={statuses} onFocus={onFocus} onClose={() => setBoard(false)} />}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
    </div>
  )
}
