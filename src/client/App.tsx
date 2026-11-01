import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, BackgroundVariant, MiniMap, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { Node, NodeChange, Edge, EdgeChange, Connection, ReactFlowInstance, XYPosition } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ContextEdge from './ContextEdge'
import WorkspaceBar from './WorkspaceBar'
import Dock from './Dock'
import Kanban from './Kanban'
import FolderPicker from './FolderPicker'
import Welcome from './Welcome'
import Login from './Login'
import CanvasToolbar from './CanvasToolbar'
import SessionsPanel, { useSessionsOpen } from './SessionsPanel'
import { CleanViewHint, useCleanView } from './cleanView'
import HelpOverlay from './HelpOverlay'
import { SettingsPanel } from './SettingsPanel'
import { nodeTypes } from './nodeTypes'
import { SettingsProvider, useSettings } from './useSettings'
import { NodeActionsProvider } from './nodeActions'
import { resolveTerminalTheme } from './themes'
import { toFlow, toWsNode, toFlowEdge, addNode } from './store'
import { canLink, bridgeExists } from './floatingEdge'
import { spawnAt, spawnPosition } from './nodeSpawn'
import { randomId } from './randomId'
import { spawnSpot } from './canvasMenu.geometry'
import { useCanvasPaneMenu } from './canvasMenu.pane'
import { decorateEdges, miniMapNodeColor, withLinkHandles } from './canvasStyle'
import { useCanvasViewport } from './canvasViewport'
import { useLayoutHistory } from './layoutHistory'
import { paneSessionIds } from './paneTree'
import { send, subscribeStatus } from './ws'
import { validateToken, storeToken, clearToken, hasToken } from './api'
import { useWorkspaceLifecycle, useWorkspaceSaver } from './workspaceLifecycle'
import { useClosedHistory } from './closedHistory'
import { agentConfig, DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentId, AgentStatus, Viewport, Workspace, WsNode } from '../shared/workspace'

const edgeTypes = { context: ContextEdge }

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // "Belum tahu" vs "memang tidak ada": sebelum fetch pertama selesai keduanya sama-sama daftar
  // kosong, dan `Welcome` yang dirender atas dasar itu selalu berkelebat sekejap.
  const [hydrated, setHydrated] = useState(false)
  // Dinaikkan saat boot fetch menjawab 403 (lihat workspaceLifecycle): render Login, bukan board.
  const [authRequired, setAuthRequired] = useState(false)
  const [activeWs, setActiveWs] = useState<Workspace | null>(null)
  // Diturunkan, bukan state sendiri: id dan board-nya pernah di-commit terpisah, dan tiap jeda
  // antara keduanya adalah satu render dengan canvas yang sudah pindah tapi datanya belum ada.
  const activeId = activeWs?.id ?? null
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [board, setBoard] = useState(false)
  const [picker, setPicker] = useState<{ onPick: (p: string) => void } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [locked, setLocked] = useState(false)
  // Di App, bukan di dalam panel: tombol pembukanya ada di Dock dan geseran dock ikut keadaan ini.
  const [sessionsOpen, setSessionsOpen] = useSessionsOpen()
  // Mode fokus: chrome disembunyikan lewat satu kelas body, tanpa meng-unmount apa pun. Lihat
  // `./cleanView` — termasuk kenapa jalan keluarnya chord dan bukan Escape.
  const [cleanView, toggleCleanView] = useCleanView()
  const { settings, update } = useSettings()
  const { entries: closedSessions, record: recordClosed, reopen: reopenClosed } = useClosedHistory(workspaces, nodes)

  const activeWsRef = useRef<Workspace | null>(null)
  const nodesRef = useRef<Node[]>([])
  const edgesRef = useRef<Edge[]>([])
  const viewportRef = useRef<Viewport>(DEFAULT_VIEWPORT)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rf = useRef<ReactFlowInstance | null>(null)

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

  // Payload dikunci di `scheduleSave`, bukan dibaca ulang saat timer menembak: board bisa berpindah
  // workspace dalam 400ms debounce. Lihat `useWorkspaceSaver` — termasuk kenapa `flushSave` wajib
  // dipanggil `applyWorkspace` sebelum board baru dipasang.
  const { scheduleSave, flushSave, cancelSave } = useWorkspaceSaver({ activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer })

  // Simpanan yang masih menggantung dibatalkan saat unmount: tanpa ini `setTimeout` di atas tetap
  // menembakkan satu PUT setelah App-nya tidak ada lagi. Di produksi App tak pernah unmount, tapi
  // di test ia menulis lewat `fetch` yang stub-nya sudah dicabut — rejection liar yang tidak bisa
  // ditelusuri ke test mana pun, dan muncul-hilang tergantung balapan.
  useEffect(() => () => cancelSave(), [cancelSave])

  // Concern viewport — readout zoom, zoom/fit, riwayat pandangan. Lihat `./canvasViewport`:
  // `viewportRef` dipinjam ke sana, jadi `scheduleSave` di atas mem-persist viewport yang
  // ditulis hook itu, bukan salinan yang sudah basi. Dideklarasikan SEBELUM `applyWorkspace`
  // karena pemasangan board memanggil `resetViewport`.
  const {
    zoom, syncViewport, onMoveEnd, onFit, onZoomIn, onZoomOut, onZoomTo,
    onBack, onForward, canBack, canForward, resetViewport,
  } = useCanvasViewport({ rf, viewportRef, scheduleSave })

  // Undo/redo layout node — tumpukan terpisah dari riwayat pandangan di atas. Lihat `./layoutHistory`.
  const { onUndo, onRedo, canUndo, canRedo, pushLayout, resetLayout } =
    useLayoutHistory({ nodesRef, setNodes, scheduleSave })

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

  // SENGAJA tanpa `sessionId`: node agent lahir TANPA session id, dan `AgentNode` mencetaknya sendiri
  // saat mount (lalu mem-persist-nya lewat `onSession` di bawah). Mencetaknya di sini membuat
  // `resumesOnFirstLaunch` membaca node yang baru lahir sebagai "pernah diluncurkan" → claude dipanggil
  // dengan `--resume <uuid>` yang belum pernah ada di disk → "No conversation found with session ID".
  const onAddAgent = useCallback((cmd: string, agentId: AgentId, cwd?: string, at?: XYPosition) => {
    const color = agentConfig(agentId)?.color
    addFlowNode((_, ws) => ({ id: randomId(), kind: 'agent', cmd, agentId, cwd: cwd ?? ws.cwd, color }), at)
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
      setWorkspaces, setActiveWs, setHydrated, setAuthRequired, setNodes, setEdges, setBoard, setPicker,
      activeWsRef, nodesRef, edgesRef, cancelSave, rf,
    })

  // Token disimpan lalu halaman di-reload: `api.ts` menangkap token sekali saat import, jadi hanya
  // load berikutnya yang membacanya kembali — reload adalah cara termalas yang benar, bukan membuat
  // modul token bisa dimutasi hidup-hidup.
  const onLogin = useCallback(async (t: string) => {
    if (await validateToken(t)) { storeToken(t); location.reload(); return true }
    return false
  }, [])
  const onLogout = useCallback(() => { clearToken(); location.reload() }, [])

  // Lewat `onNodesChange`, bukan setNodes langsung: riwayat & persistensi menggantung di sana.
  const onSelectAll = useCallback(() => {
    onNodesChange(nodesRef.current.map((n) => ({ type: 'select' as const, id: n.id, selected: true })))
  }, [onNodesChange])

  const { onPaneContextMenu, menu: paneMenu } = useCanvasPaneMenu({
    rf, settings, nodeCount: nodes.length, onAddTerminal, onAddFiles, onAddAgent, onFit, onSelectAll,
  })

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

  // Gerbang auth: board tak pernah dirender sebelum token cocok. Di LUAR SettingsProvider tak apa —
  // Login tidak membaca settings. Sesudah semua hook, jadi urutan hook App tetap stabil antar render.
  if (authRequired) return <div className="app-shell"><Login onSubmit={onLogin} /></div>

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
        onLogout={onLogout}
        showLogout={hasToken()}
      />
      {/* Satu-satunya pembawa tinggi canvas; `Welcome` (position: absolute; inset: 0) dan
          ReactFlow sama-sama mengisinya. Panel mengapung TIDAK ikut masuk ke sini: `top`-nya
          dihitung dari atas viewport lewat --tabbar-h/--ss-top-chrome, jadi menaruhnya di dalam
          .app-main akan menghitung tinggi header dua kali. */}
      <div className="app-main">
        {!hydrated ? null : noWorkspaces ? (
          <Welcome
            onNewProject={onNewProject}
            onCreateEmpty={(name) => void onCreateWorkspace(name)}
            closedSessions={closedSessions}
            onReopen={(id) => void reopenClosed(id, { activeId, addNode: addFlowNode, setWorkspaces, selectWorkspace: onSelect })}
          />
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
            onPaneContextMenu={onPaneContextMenu}
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
            canUndo={canUndo}
            canRedo={canRedo}
            onBack={onBack}
            onForward={onForward}
            canBack={canBack}
            canForward={canForward}
            onFit={onFit}
            onToggleBoard={() => setBoard((v) => !v)}
            sessionsOpen={sessionsOpen}
            onToggleSessions={() => setSessionsOpen((v) => !v)}
            zoomPct={Math.round(zoom * 100)}
            onZoomIn={onZoomIn}
            onZoomOut={onZoomOut}
            onZoomTo={onZoomTo}
            locked={locked}
            onToggleLock={() => setLocked((v) => !v)}
            cleanView={cleanView}
            onToggleCleanView={toggleCleanView}
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
            open={sessionsOpen}
            onClose={() => setSessionsOpen(false)}
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
          {paneMenu}
        </>
      )}
      {/* Di luar blok `hydrated && !noWorkspaces`: chord-nya tidak digerbangi apa pun, jadi
          petunjuk jalan keluarnya juga tidak boleh. */}
      {cleanView && <CleanViewHint />}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
      {showSettings && <SettingsPanel settings={settings} onChange={update} onClose={() => setShowSettings(false)} />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
    </NodeActionsProvider>
    </SettingsProvider>
  )
}
