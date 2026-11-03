import { useCallback, useMemo } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { Node, NodeChange, Edge, EdgeChange, Connection, ReactFlowInstance, XYPosition } from '@xyflow/react'
import { toFlow, toWsNode, toFlowEdge, addNode } from './store'
import { canLink, bridgeExists } from './floatingEdge'
import { spawnAt, spawnPosition } from './nodeSpawn'
import { randomId } from './randomId'
import { spawnSpot } from './canvasMenu.geometry'
import { paneSessionIds } from './paneTree'
import { send } from './ws'
import { useBrowserAdd } from './useBrowserAdd'
import { useBrowserOpen } from './useBrowserOpen'
import type { ClosedHistory } from './closedHistory'
import { agentConfig, DEFAULT_VIEWPORT } from '../shared/workspace'
import type { Settings } from '../shared/settings'
import type { AgentId, Viewport, Workspace, WsNode } from '../shared/workspace'

export interface BoardDeps {
  rf: RefObject<ReactFlowInstance | null>
  activeWsRef: RefObject<Workspace | null>
  nodesRef: RefObject<Node[]>
  edgesRef: RefObject<Edge[]>
  settings: Settings
  activeId: string | null
  browserReady: boolean
  setActiveWs: Dispatch<SetStateAction<Workspace | null>>
  setNodes: Dispatch<SetStateAction<Node[]>>
  setEdges: Dispatch<SetStateAction<Edge[]>>
  flushSave: () => void
  scheduleSave: () => void
  resetViewport: (vp: Viewport) => void
  resetLayout: (nodes: Node[]) => void
  pushLayout: (nodes: Node[]) => void
  recordClosed: ClosedHistory['record']
}

/** Mutasi board (pasang workspace, perubahan node/edge, tambah node) beserta persist & riwayat layout-nya. */
export function useBoardActions({
  rf, activeWsRef, nodesRef, edgesRef, settings, activeId, browserReady,
  setActiveWs, setNodes, setEdges, flushSave, scheduleSave, resetViewport, resetLayout, pushLayout, recordClosed,
}: BoardDeps) {
  const applyWorkspace = useCallback((ws: Workspace) => {
    // Save yang masih menggantung milik board LAMA: tulis dulu dengan payload yang sudah terkunci,
    // baru pasang board ini. Tanpa ini timer-nya menembak belakangan dan menulis board baru ke id lama.
    flushSave()
    setActiveWs(ws)
    activeWsRef.current = ws
    resetViewport(ws.viewport ?? DEFAULT_VIEWPORT)
    const flow = ws.nodes.map(toFlow)
    nodesRef.current = flow
    setNodes(flow)
    const fe = (ws.bridges ?? []).map(toFlowEdge)
    edgesRef.current = fe
    setEdges(fe)
    resetLayout(flow)
  }, [flushSave, resetViewport, resetLayout])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Di LUAR updater: `recordClosed` setState, dan dari dalam updater itu menulis di fase render.
    const gone = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []))
    if (gone.length) {
      recordClosed(gone, nodesRef.current.map(toWsNode), activeWsRef.current)
      // Satu node bisa memegang banyak PTY (split pane), jadi yang ditutup adalah tiap DAUN-nya:
      // `close` untuk id node saja meninggalkan shell pane kedua dan seterusnya hidup tanpa pemilik
      // sampai server restart. Di LUAR updater, alasannya sama dengan `recordClosed`: updater
      // setState bisa dijalankan lebih dari sekali dan efeknya ikut terkirim dua kali.
      for (const sid of paneSessionIds(nodesRef.current, gone)) send({ t: 'close', id: sid })
    }
    setNodes((prev) => {
      const next = applyNodeChanges(changes, prev)
      nodesRef.current = next
      // 'add' ikut dihitung: node yang dibuat di dalam node lain (FilesNode membuka file sebagai
      // node editor di sebelahnya) masuk lewat `addNodes`, bukan lewat `addFlowNode` di bawah —
      // tanpa cabang ini node itu tidak pernah tersimpan dan tidak bisa di-undo.
      const settled = changes.some(
        (c) => (c.type === 'position' && !c.dragging) || c.type === 'remove' || c.type === 'add' || (c.type === 'dimensions' && !c.resizing),
      )
      if (settled) {
        scheduleSave()
        pushLayout(next)
      } else if (changes.some((c) => c.type === 'replace')) {
        // Data-only change (collapse/color/rename/comments/hideLinks via updateNodeData):
        // persist but DON'T push to layout history — mirrors onSession.
        scheduleSave()
      }
      return next
    })
  }, [recordClosed, scheduleSave, pushLayout])

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
      // 'add' ikut dihitung, kelas bug yang sama dengan node di `onNodesChange`: kabel yang dibuat
      // di dalam node lain (FilesNode menandai file yang terbuka) masuk lewat `rf.addEdges`, yang
      // diantar ke sini sebagai change 'add' — tanpa cabang ini kabelnya hilang setelah reload.
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) scheduleSave()
      return next
    })
  }, [scheduleSave])

  // Spawn SEBELUM `make`: node baru lahir di tengah pandangan, node yang dibuka ulang menimpanya dengan x/y aslinya.
  // `at` (koordinat FLOW) menggantikan "tengah pandangan": menu konteks canvas memakainya.
  const addFlowNode = useCallback((make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>, at?: XYPosition) => {
    const ws = activeWsRef.current
    if (!ws) return
    setNodes((prev) => {
      const size = { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight }
      const spot = spawnSpot(at) // Lihat `spawnSpot`: `at` bisa berisi event, bukan titik.
      const node = { ...size, ...(spot ? spawnPosition(spot, size, 0) : spawnAt(rf.current, settings, prev.length)), ...make(prev.length, ws) }
      const next = addNode(prev.map(toWsNode), node).map(toFlow)
      // Round-trip `toWsNode`/`toFlow` tidak membawa `selected`, jadi yang lain sudah ter-deselect;
      next[next.length - 1].selected = true // node baru selalu terakhir (`addNode` append).
      nodesRef.current = next
      scheduleSave()
      pushLayout(next)
      return next
    })
  }, [scheduleSave, pushLayout, settings.defaultNodeWidth, settings.defaultNodeHeight])

  const onAddTerminal = useCallback((at?: XYPosition) => addFlowNode((_, ws) => ({ id: randomId(), kind: 'terminal', cwd: ws.cwd }), at), [addFlowNode])

  // webterm tidak punya drawer Explorer seperti nodeterm; tombol Explorer cluster kontrol
  // menumbuhkan node file-manager di cwd workspace, satu-satunya jalan masuk ke filesystem.
  const onAddFiles = useCallback((at?: XYPosition) => addFlowNode((_, ws) => ({ id: randomId(), kind: 'files', dirPath: ws.cwd }), at), [addFlowNode])
  const onAddBrowser = useBrowserAdd(addFlowNode, activeId, browserReady) // undefined = fitur mati di server
  const defaultSize = useMemo(() => ({ width: settings.defaultNodeWidth, height: settings.defaultNodeHeight }), [settings.defaultNodeWidth, settings.defaultNodeHeight])
  const openBrowserAt = useBrowserOpen({ enabled: onAddBrowser !== undefined, addFlowNode, rf, nodesRef, setNodes, defaultSize })

  // SENGAJA tanpa `sessionId`: node agent lahir TANPA session id, dan `AgentNode` mencetaknya sendiri
  // saat mount (lalu mem-persist-nya lewat `onSession` di bawah). Mencetaknya di sini membuat
  // `resumesOnFirstLaunch` membaca node yang baru lahir sebagai "pernah diluncurkan" → claude dipanggil
  // dengan `--resume <uuid>` yang belum pernah ada di disk → "No conversation found with session ID".
  const onAddAgent = useCallback((cmd: string, agentId: AgentId, cwd?: string, at?: XYPosition) => {
    // Custom tanpa warna sendiri mewarisi warna baseAgent (kontrak `CustomAgent.color`).
    const custom = settings.customAgents.find((c) => c.id === agentId)
    const color = agentConfig(agentId)?.color ?? custom?.color ?? (custom?.baseAgent && agentConfig(custom.baseAgent)?.color)
    addFlowNode((_, ws) => ({ id: randomId(), kind: 'agent', cmd, agentId, cwd: cwd ?? ws.cwd, color }), at)
  }, [addFlowNode, settings.customAgents])

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
  const onToggleHideLinks = useCallback((id: string) => {
    const cur = nodesRef.current.find((n) => n.id === id)
    rf.current?.updateNodeData(id, { hideLinks: !(cur?.data as { hideLinks?: boolean })?.hideLinks })
  }, [])

  const nodeActions = useMemo(() => ({ onSession, onToggleHideLinks, openBrowserAt }), [onSession, onToggleHideLinks, openBrowserAt])

  return { applyWorkspace, onNodesChange, onConnect, onEdgesChange, addFlowNode, onAddTerminal, onAddFiles, onAddBrowser, onAddAgent, nodeActions }
}
