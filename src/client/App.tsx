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
import { resolveTerminalTheme } from './themes'
import { toFlow, toWsNode, toFlowEdge, toBridge, addNode, workspaceNameFromPath } from './store'
import { canLink, bridgeExists } from './floatingEdge'
import { decorateEdges, miniMapNodeColor, withLinkHandles } from './canvasStyle'
import { createHistory } from './history'
import { send, subscribeStatus } from './ws'
import { fetchWorkspaces, getActive, setActive, getWorkspace, createWorkspace, saveWorkspace, deleteWorkspace } from './api'
import { nextActiveWorkspaceId } from './workspaceMenu'
import { useClosedHistory } from './closedHistory'
import { agentConfig, DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentId, AgentStatus, Viewport, Workspace, WsNode } from '../shared/workspace'

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
    const unsub = subscribeStatus((id, s) => setStatuses((prev) => ({ ...prev, [id]: s })))
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

  const loadWorkspace = useCallback(async (id: string) => {
    applyWorkspace(await getWorkspace(id))
  }, [applyWorkspace])

  useEffect(() => {
    void (async () => {
      const [list, active] = await Promise.all([fetchWorkspaces(), getActive()])
      setWorkspaces(list)
      // Pointer aktif di server bisa menunjuk row yang sudah DIHAPUS: menghapus workspace terakhir
      // tidak bisa mengosongkan pointer itu (`PUT /api/active` menolak id kosong dengan 400), dan
      // memuat id mati melempar 404 tepat di sini. Jadi hanya id yang masih ada yang dipakai,
      // sisanya tab pertama — atau tidak ada sama sekali, yang berarti layar `Welcome`.
      const id = active && list.some((w) => w.id === active) ? active : list[0]?.id ?? null
      if (id) {
        if (id !== active) await setActive(id)
        setActiveId(id)
        await loadWorkspace(id)
      }
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

  const addFlowNode = useCallback((make: (n: number, ws: Workspace) => WsNode) => {
    const ws = activeWsRef.current
    if (!ws) return
    setNodes((prev) => {
      const node = { width: settings.defaultNodeWidth, height: settings.defaultNodeHeight, ...make(prev.length, ws) }
      const next = addNode(prev.map(toWsNode), node).map(toFlow)
      nodesRef.current = next
      scheduleSave()
      nodeHist.current.push(next)
      bump()
      return next
    })
  }, [scheduleSave, settings.defaultNodeWidth, settings.defaultNodeHeight])

  const onAddTerminal = useCallback(() => {
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'terminal', x: 80 + n * 40, y: 80 + n * 40, cwd: ws.cwd }))
  }, [addFlowNode])

  // webterm tidak punya drawer Explorer seperti nodeterm; tombol Explorer cluster kontrol
  // menumbuhkan node file-manager di cwd workspace, satu-satunya jalan masuk ke filesystem.
  const onAddFiles = useCallback(() => {
    addFlowNode((n, ws) => ({ id: crypto.randomUUID(), kind: 'files', x: 80 + n * 40, y: 80 + n * 40, dirPath: ws.cwd }))
  }, [addFlowNode])

  const onAddAgent = useCallback((cmd: string, agentId: AgentId, cwd?: string) => {
    const color = agentConfig(agentId)?.color
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

  const onSelect = useCallback(async (id: string) => {
    if (!id || id === activeId) return
    await setActive(id)
    setActiveId(id)
    await loadWorkspace(id)
  }, [activeId, loadWorkspace])

  // Baris sidebar bisa milik workspace LAIN yang nodenya tidak ter-mount, kelas jebakan yang sama
  // dengan `closeSession` di bawah: dulu `if (!node) return` menelan klik itu diam-diam. Node dicari
  // ULANG setelah pindah karena `onSelect` → `applyWorkspace` menulis `nodesRef` secara sinkron,
  // jadi begitu await selesai isinya sudah board yang baru — tanpa perlu menunggu render.
  const onFocus = useCallback(async (id: string) => {
    if (!nodesRef.current.some((n) => n.id === id)) {
      const owner = workspaces.find((w) => w.nodes.some((n) => n.id === id))
      if (!owner) return
      await onSelect(owner.id)
    }
    const node = nodesRef.current.find((n) => n.id === id)
    if (!node) return
    rf.current?.setCenter(node.position.x + 240, node.position.y + 160, { zoom: 1, duration: 400 })
    setBoard(false)
  }, [onSelect, workspaces])

  // Sidebar mendaftar sesi dari SEMUA workspace, jadi baris yang ditutup belum tentu ada di
  // canvas yang ter-mount. Yang di luar canvas dibuang dari salinan TERBARU di server: snapshot
  // `workspaces` di client hanya di-refresh saat workspace dibuat, jadi menulis ulang dari sana
  // akan mengembalikan layout workspace itu ke keadaan lama.
  const closeSession = useCallback(async (id: string) => {
    if (nodesRef.current.some((n) => n.id === id)) {
      await rf.current?.deleteElements({ nodes: [{ id }] })
      return
    }
    const owner = workspaces.find((w) => w.nodes.some((n) => n.id === id))
    if (!owner) return
    send({ t: 'close', id })
    const fresh = await getWorkspace(owner.id)
    recordClosed([id], fresh.nodes, fresh)
    const updated: Workspace = { ...fresh, nodes: fresh.nodes.filter((n) => n.id !== id), updatedAt: Date.now() }
    await saveWorkspace(updated)
    setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
  }, [recordClosed, workspaces])

  // Rename dari menu kebab header. Rutenya BEDA tergantung workspace itu sedang terbuka atau
  // tidak — kelas jebakan yang sama dengan `closeSession` di atas.
  const onRenameWorkspace = useCallback(async (id: string, name: string) => {
    const live = activeWsRef.current
    if (live?.id === id) {
      // Workspace AKTIF tidak boleh lewat GET+PUT: salinan server bisa ketinggalan sampai 400ms
      // dari canvas yang hidup (debounce `scheduleSave`), jadi menulisnya kembali membatalkan edit
      // terakhir pengguna. Yang benar: ganti nama di `activeWsRef` — sumber payload `scheduleSave`
      // — lalu biarkan save berikutnya membawa nama baru bersama layout TERBARU. Nama yang hanya
      // hidup di state React akan ditimpa kembali dengan nama lama oleh edit canvas berikutnya.
      activeWsRef.current = { ...live, name }
      setActiveWs((ws) => (ws && ws.id === id ? { ...ws, name } : ws))
      setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)))
      scheduleSave()
      return
    }
    // Workspace lain: ambil salinan TERBARU dari server, ubah satu field, kirim itu. Snapshot
    // `workspaces` di client hanya di-refresh saat workspace dibuat, jadi PUT dari sana akan
    // mengembalikan node/viewport workspace itu ke keadaan lama.
    const fresh = await getWorkspace(id)
    const updated: Workspace = { ...fresh, name, updatedAt: Date.now() }
    await saveWorkspace(updated)
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? updated : w)))
  }, [scheduleSave])

  // Hapus workspace (sudah dikonfirmasi di header). Tidak bisa dibatalkan: row + board tersimpan.
  const onDeleteWorkspace = useCallback(async (id: string) => {
    if (id === activeId && saveTimer.current) {
      // Debounce yang masih menggantung akan PUT id ini SETELAH row-nya hilang dan menghidupkannya
      // kembali (PUT = upsert). Hanya untuk workspace aktif: timer itu selalu milik board aktif,
      // membatalkannya saat menghapus workspace lain berarti membuang save yang sah.
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // Sesi PTY tidak mati sendiri saat row-nya hilang — node yang unmount sengaja TIDAK menutup
    // sesinya (itu yang membuat board bertahan saat pindah workspace), jadi shell-nya ditutup di
    // sini atau bocor tanpa pemilik. Daftar node diambil dari server karena snapshot client bisa
    // ketinggalan untuk workspace yang tidak aktif; GET gagal pun hapusnya tetap jalan.
    const doomed = await getWorkspace(id).catch(() => null)
    for (const n of doomed?.nodes ?? []) send({ t: 'close', id: n.id })
    await deleteWorkspace(id)
    const next = nextActiveWorkspaceId(workspaces.map((w) => w.id), id, activeId)
    setWorkspaces((prev) => prev.filter((w) => w.id !== id))
    if (next === activeId) return // yang dihapus bukan yang aktif: board di layar tidak tersentuh
    if (next) {
      await setActive(next)
      setActiveId(next)
      await loadWorkspace(next)
      return
    }
    // Workspace terakhir: mendarat di `Welcome` dengan canvas kosong. `activeWsRef` dikosongkan
    // supaya `scheduleSave` berhenti di baris pertamanya, bukan menulis board hantu.
    setActiveId(null)
    setActiveWs(null)
    activeWsRef.current = null
    nodesRef.current = []
    edgesRef.current = []
    setNodes([])
    setEdges([])
  }, [activeId, loadWorkspace, workspaces])

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

  const nodeColor = useCallback((n: Node) => miniMapNodeColor(n, statuses), [statuses])

  const onToggleHideLinks = useCallback((id: string) => {
    const cur = nodesRef.current.find((n) => n.id === id)
    rf.current?.updateNodeData(id, { hideLinks: !(cur?.data as { hideLinks?: boolean })?.hideLinks })
  }, [])

  // Inject onSession + the hideLinks eye handler into agent nodes, for rendering only; toWsNode
  // drops both. Settings TIDAK lewat sini — lihat `useLiveSettings`. Hasilnya DIPAKU ke `Node[]`:
  // tanpa itu React Flow menyimpulkan tipe node dari suntikan ini dan `rf` default tak cocok lagi.
  const flowNodes = useMemo<Node[]>(
    () => nodes.map((n) => {
      const base = withLinkHandles(n)
      return n.type === 'agent'
        ? { ...base, data: { ...n.data, onSession, onToggleHideLinks: () => onToggleHideLinks(n.id) } }
        : base
    }),
    [nodes, onSession, onToggleHideLinks],
  )

  const liveNodes = useMemo(() => nodes.map(toWsNode), [nodes])

  const displayEdges = useMemo(() => decorateEdges(edges, nodes), [edges, nodes])

  const noWorkspaces = workspaces.length === 0

  return (
    <SettingsProvider value={settings}>
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
        {noWorkspaces ? (
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
            <MiniMap className="minimap-dock" pannable zoomable maskColor="rgba(10,12,18,0.6)" nodeColor={nodeColor} />
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
      {!noWorkspaces && (
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
    </SettingsProvider>
  )
}
