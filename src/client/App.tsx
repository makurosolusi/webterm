import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { Node, NodeChange, Edge, EdgeChange, Connection, ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ContextEdge from './ContextEdge'
import WorkspaceBar from './WorkspaceBar'
import Dock from './Dock'
import Kanban from './Kanban'
import FolderPicker from './FolderPicker'
import Welcome from './Welcome'
import CanvasToolbar from './CanvasToolbar'
import ZoomRail from './ZoomRail'
import SessionsPanel from './SessionsPanel'
import HelpOverlay from './HelpOverlay'
import { SettingsPanel } from './SettingsPanel'
import { nodeTypes } from './nodeTypes'
import { SettingsProvider, useSettings } from './useSettings'
import { NodeActionsProvider } from './nodeActions'
import { resolveTerminalTheme } from './themes'
import { toFlow, toWsNode, toFlowEdge, toBridge, addNode } from './store'
import { canLink, bridgeExists } from './floatingEdge'
import { spawnAt } from './nodeSpawn'
import { decorateEdges, miniMapNodeColor, withLinkHandles } from './canvasStyle'
import { createHistory } from './history'
import { send, subscribeStatus } from './ws'
import { saveWorkspace } from './api'
import { useWorkspaceLifecycle } from './workspaceLifecycle'
import { useClosedHistory } from './closedHistory'
import { agentConfig, DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentId, AgentStatus, Viewport, Workspace, WsNode } from '../shared/workspace'

const edgeTypes = { context: ContextEdge }

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // "Belum tahu" vs "memang tidak ada": sebelum fetch pertama selesai keduanya sama-sama daftar
  // kosong, dan `Welcome` yang dirender atas dasar itu selalu berkelebat sekejap.
  const [hydrated, setHydrated] = useState(false)
  const [activeWs, setActiveWs] = useState<Workspace | null>(null)
  // Diturunkan, bukan state sendiri: id dan board-nya pernah di-commit terpisah, dan tiap jeda
  // antara keduanya adalah satu render dengan canvas yang sudah pindah tapi datanya belum ada.
  const activeId = activeWs?.id ?? null
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [board, setBoard] = useState(false)
  const [picker, setPicker] = useState<{ onPick: (p: string) => void } | null>(null)
  const [zoom, setZoom] = useState(DEFAULT_VIEWPORT.zoom)
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [locked, setLocked] = useState(false)
  const { settings, update } = useSettings()
  const { entries: closedSessions, record: recordClosed, reopen: reopenClosed } = useClosedHistory(workspaces, nodes)

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
    // `s` undefined = sapuan basi mencabut statusnya (`shared/agentStale.ts`), jadi key-nya DIHAPUS:
    // menaruh `undefined` di bawah key yang masih ada akan membuat node terbaca berstatus kosong.
    const unsub = subscribeStatus((id, s) =>
      setStatuses((prev) => {
        const next = { ...prev }
        if (s) next[id] = s
        else delete next[id]
        return next
      })
    )
    return unsub
  }, [])

  // Satu-satunya penulis `data-theme`; `styles.css` menyimpan varian terangnya di
  // `:root[data-theme='light']`. 'auto' mengikut tema terminal supaya memilih skema terang
  // tidak menyisakan rangka hitam di sekelilingnya.
  useEffect(() => {
    const dark = settings.appTheme === 'auto'
      ? resolveTerminalTheme(settings.terminalTheme).dark
      : settings.appTheme === 'dark'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [settings.appTheme, settings.terminalTheme])

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
    // Di LUAR updater: `recordClosed` setState, dan dari dalam updater itu menulis di fase render.
    const gone = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []))
    if (gone.length) recordClosed(gone, nodesRef.current.map(toWsNode), activeWsRef.current)
    setNodes((prev) => {
      const next = applyNodeChanges(changes, prev)
      nodesRef.current = next
      if (changes.some((c) => c.type === 'remove')) {
        for (const c of changes) if (c.type === 'remove') send({ t: 'close', id: c.id })
      }
      // 'add' ikut dihitung: node yang dibuat di dalam node lain (FilesNode membuka file sebagai
      // node editor di sebelahnya) masuk lewat `addNodes`, bukan lewat `addFlowNode` di bawah —
      // tanpa cabang ini node itu tidak pernah tersimpan dan tidak bisa di-undo.
      const settled = changes.some(
        (c) => (c.type === 'position' && !c.dragging) || c.type === 'remove' || c.type === 'add' || (c.type === 'dimensions' && !c.resizing),
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
  }, [recordClosed, scheduleSave])

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
      // 'add' ikut dihitung, kelas bug yang sama dengan node di `onNodesChange`: kabel yang dibuat
      // di dalam node lain (FilesNode menandai file yang terbuka) masuk lewat `rf.addEdges`, yang
      // diantar ke sini sebagai change 'add' — tanpa cabang ini kabelnya hilang setelah reload.
      if (changes.some((c) => c.type === 'remove' || c.type === 'add')) scheduleSave()
      return next
    })
  }, [scheduleSave])

  // Spawn SEBELUM `make`: node baru lahir di tengah pandangan, node yang dibuka ulang menimpanya dengan x/y aslinya.
  const addFlowNode = useCallback((make: (n: number, ws: Workspace) => Omit<WsNode, 'x' | 'y'>) => {
    const ws = activeWsRef.current
    if (!ws) return
    setNodes((prev) => {
      const node = { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight, ...spawnAt(rf.current, settings, prev.length), ...make(prev.length, ws) }
      const next = addNode(prev.map(toWsNode), node).map(toFlow)
      // Round-trip `toWsNode`/`toFlow` tidak membawa `selected`, jadi yang lain sudah ter-deselect;
      next[next.length - 1].selected = true // node baru selalu terakhir (`addNode` append).
      nodesRef.current = next
      scheduleSave()
      nodeHist.current.push(next)
      bump()
      return next
    })
  }, [scheduleSave, settings.defaultNodeWidth, settings.defaultNodeHeight])

  const onAddTerminal = useCallback(() => addFlowNode((_, ws) => ({ id: crypto.randomUUID(), kind: 'terminal', cwd: ws.cwd })), [addFlowNode])

  // webterm tidak punya drawer Explorer seperti nodeterm; tombol Explorer cluster kontrol
  // menumbuhkan node file-manager di cwd workspace, satu-satunya jalan masuk ke filesystem.
  const onAddFiles = useCallback(() => addFlowNode((_, ws) => ({ id: crypto.randomUUID(), kind: 'files', dirPath: ws.cwd })), [addFlowNode])

  // SENGAJA tanpa `sessionId`: node agent lahir TANPA session id, dan `AgentNode` mencetaknya sendiri
  // saat mount (lalu mem-persist-nya lewat `onSession` di bawah). Mencetaknya di sini membuat
  // `resumesOnFirstLaunch` membaca node yang baru lahir sebagai "pernah diluncurkan" → claude dipanggil
  // dengan `--resume <uuid>` yang belum pernah ada di disk → "No conversation found with session ID".
  const onAddAgent = useCallback((cmd: string, agentId: AgentId, cwd?: string) => {
    const color = agentConfig(agentId)?.color
    addFlowNode((_, ws) => ({ id: crypto.randomUUID(), kind: 'agent', cmd, agentId, cwd: cwd ?? ws.cwd, color }))
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

  // Siklus hidup workspace — board MANA yang dibuka (boot, pindah tab, rename, hapus, buat) plus
  // aksi sesi lintas-workspace. Lihat `./workspaceLifecycle`: ref & setter dipinjam apa adanya,
  // jadi `scheduleSave` dan canvas tetap membaca ref yang SAMA dengan yang ditulis di sana.
  const { onSelect, onFocus, closeSession, onRenameWorkspace, onDeleteWorkspace, onCreateWorkspace, onNewProject } =
    useWorkspaceLifecycle({
      workspaces, activeId, applyWorkspace, scheduleSave, recordClosed,
      setWorkspaces, setActiveWs, setHydrated, setNodes, setEdges, setBoard, setPicker,
      activeWsRef, nodesRef, edgesRef, saveTimer, rf,
    })

  // Perpindahan programatik (setViewport/zoomIn/fitView) lewat setTransform tidak mengirim
  // sourceEvent sama sekali, jadi onMoveEnd kemungkinan besar TETAP jalan. Panggilan ini
  // jaring pengaman eksplisit: sync readout + persist tanpa bergantung pada jalur event.
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

  const nodeColor = useCallback((n: Node) => miniMapNodeColor(n, statuses), [statuses])

  const onToggleHideLinks = useCallback((id: string) => {
    const cur = nodesRef.current.find((n) => n.id === id)
    rf.current?.updateNodeData(id, { hideLinks: !(cur?.data as { hideLinks?: boolean })?.hideLinks })
  }, [])

  const nodeActions = useMemo(() => ({ onSession, onToggleHideLinks }), [onSession, onToggleHideLinks])

  // TIDAK ada suntikan apa pun ke `data` di sini — callback lewat `useNodeActions`, settings lewat
  // `useLiveSettings`. Node terminal/agent jadi mewarisi identitas objek aslinya (`withLinkHandles`
  // memulangkan `n` itu sendiri kecuali files/editor), satu-satunya cara `memo` menggigit saat drag.
  const flowNodes = useMemo(() => nodes.map(withLinkHandles), [nodes])

  const liveNodes = useMemo(() => nodes.map(toWsNode), [nodes])

  const displayEdges = useMemo(() => decorateEdges(edges, nodes), [edges, nodes])

  const noWorkspaces = workspaces.length === 0

  return (
    <SettingsProvider value={settings}>
    <NodeActionsProvider value={nodeActions}>
    <div className="app-shell">
      {/* Header dirender SELALU — juga di layar Welcome: tombol `+`-nya adalah jalan masuk yang
          sama, dan header yang baru muncul setelah workspace pertama akan menggeser canvas
          46px ke bawah tepat saat pengguna menekan tombol. Lihat catatan di WorkspaceBar. */}
      <WorkspaceBar
        workspaces={workspaces}
        activeId={activeId}
        liveActiveNodes={liveNodes}
        statuses={statuses}
        onSelect={onSelect}
        onNewWorkspace={onNewProject}
        onRenameWorkspace={(id, name) => void onRenameWorkspace(id, name)}
        onDeleteWorkspace={(id) => void onDeleteWorkspace(id)}
      />
      {/* Satu-satunya pembawa tinggi canvas; `Welcome` (position: absolute; inset: 0) dan
          ReactFlow sama-sama mengisinya. Panel mengapung TIDAK ikut masuk ke sini: `top`-nya
          dihitung dari atas viewport lewat --tabbar-h/--ss-top-chrome, jadi menaruhnya di dalam
          .app-main akan menghitung tinggi header dua kali. */}
      <div className="app-main">
        {!hydrated ? null : noWorkspaces ? (
          <Welcome onNewProject={onNewProject} onCreateEmpty={(name) => void onCreateWorkspace(name)} />
        ) : (
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
            snapToGrid={settings.snapToGrid}
            snapGrid={[settings.gridSize, settings.gridSize]}
            panOnDrag={!locked}
            panOnScroll={!locked}
            zoomOnPinch={!locked}
            zoomOnScroll={false}
            proOptions={{ hideAttribution: true }}
          >
            {settings.canvasDots && (
              <Background variant={BackgroundVariant.Dots} gap={settings.gridSize} size={2.5} color="var(--canvas-dot)" />
            )}
            <MiniMap
              className="minimap-dock" pannable zoomable maskColor="rgba(10,12,18,0.6)" nodeColor={nodeColor}
              // `p` sudah koordinat flow: viewBox minimap digambar di ruang itu, jadi tak perlu dikonversi.
              // `setCenter` tanpa `zoom` jatuh ke maxZoom, bukan zoom sekarang — klik cuma boleh
              // memindahkan titik pandang, jadi zoom berjalan diteruskan eksplisit.
              onClick={(_, p) => {
                const vp = rf.current?.getViewport()
                if (vp) { rf.current?.setCenter(p.x, p.y, { zoom: vp.zoom, duration: 300 }); syncViewport(320) }
              }}
            />
            <ZoomRail
              locked={locked}
              onToggleLock={() => setLocked((v) => !v)}
              onZoomIn={() => { rf.current?.zoomIn({ duration: 150 }); syncViewport(170) }}
              onZoomOut={() => { rf.current?.zoomOut({ duration: 150 }); syncViewport(170) }}
              onFit={() => { rf.current?.fitView({ duration: 300 }); syncViewport(320) }}
            />
          </ReactFlow>
        )}
      </div>
      {hydrated && !noWorkspaces && (
        <>
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
            onZoomTo={(p) => { rf.current?.zoomTo(p / 100, { duration: 150 }); syncViewport(170) }}
            disabledAgents={settings.disabledAgents}
            customAgents={settings.customAgents}
            agentLaunchCommands={settings.agentLaunchCommands}
          />
          <CanvasToolbar
            nodes={flowNodes}
            onFocusNode={onFocus}
            onOpenExplorer={onAddFiles}
            onOpenSettings={() => setShowSettings(true)}
            onOpenHelp={() => setShowHelp(true)}
          />
          <SessionsPanel
            workspaces={workspaces}
            activeId={activeId}
            liveActiveNodes={liveNodes}
            statuses={statuses}
            onFocusNode={onFocus}
            onCloseSession={(id) => void closeSession(id)}
            onSelectWorkspace={(id) => void onSelect(id)}
            closedSessions={closedSessions}
            onReopenSession={(id) => void reopenClosed(id, { activeId, addNode: addFlowNode, setWorkspaces, selectWorkspace: onSelect })}
          />
          {board && <Kanban nodes={flowNodes} statuses={statuses} onFocus={onFocus} onClose={() => setBoard(false)} />}
        </>
      )}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
      {showSettings && <SettingsPanel settings={settings} onChange={update} onClose={() => setShowSettings(false)} />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
    </NodeActionsProvider>
    </SettingsProvider>
  )
}
