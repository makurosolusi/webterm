import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import WorkspaceBar from './WorkspaceBar'
import Dock from './Dock'
import Kanban from './Kanban'
import FolderPicker from './FolderPicker'
import Welcome from './Welcome'
import Login from './Login'
import CanvasToolbar from './CanvasToolbar'
import SessionsPanel, { useSessionsOpen } from './SessionsPanel'
import InboxPanel from './InboxPanel'
import ChatPanel, { useChatOpen } from './ChatPanel'
import CentralControlPanel, { useCentralControl } from './central/CentralControlPanel'
import { useInboxOpen } from './inboxPanelModel'
import { CleanViewHint, useCleanView } from './cleanView'
import HelpOverlay from './HelpOverlay'
import OutputPanelHost from './output/outputPanelHost'
import { SettingsPanel } from './SettingsPanel'
import { SettingsProvider, useSettings } from './useSettings'
import { NodeActionsProvider } from './nodeActions'
import { toWsNode } from './store'
import { useCanvasPaneMenu } from './canvasMenu.pane'
import { BrowserLinkOfferHost } from './browserLinkOffer'
import { decorateEdges, miniMapNodeColor, withLinkHandles } from './canvasStyle'
import { useCanvasViewport } from './canvasViewport'
import { setNotifyCanvas } from './osNotify'
import { useLayoutHistory } from './layoutHistory'
import { hasToken } from './api'
import { useWorkspaceLifecycle, useWorkspaceSaver } from './workspaceLifecycle'
import { useClosedHistory } from './closedHistory'
import SessionHistory from './SessionHistory'
import { useBoardActions } from './App.board'
import BoardCanvas from './App.canvas'
import { useStatusSubscription, useAppTheme, useAuthActions, useAgentSummary, useDockFeeds } from './App.hooks'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentStatus, Viewport, Workspace } from '../shared/workspace'

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
  // Sama seperti Sessions: tombolnya di Dock, jadi keadaannya milik App yang merender keduanya.
  const [inboxOpen, setInboxOpen] = useInboxOpen()
  // Chat adalah permukaan ketiga yang mengapung di atas canvas (bukan node): state-nya di App
  // karena tombol pembukanya di Dock, sama seperti Sessions/Inbox.
  const [chatOpen, setChatOpen] = useChatOpen()
  const central = useCentralControl()
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

  useStatusSubscription(setStatuses)
  useAppTheme(settings)

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

  const {
    applyWorkspace, onNodesChange, onConnect, onEdgesChange, addFlowNode, onAddTerminal, onAddFiles, onAddBrowser, onAddAgent, nodeActions,
  } = useBoardActions({
    rf, activeWsRef, nodesRef, edgesRef, settings, activeId, browserReady: hydrated && !authRequired,
    setActiveWs, setNodes, setEdges, flushSave, scheduleSave, resetViewport, resetLayout, pushLayout, recordClosed,
  })


  // Siklus hidup workspace — board MANA yang dibuka (boot, pindah tab, rename, hapus, buat) plus
  // aksi sesi lintas-workspace. Lihat `./workspaceLifecycle`: ref & setter dipinjam apa adanya,
  // jadi `scheduleSave` dan canvas tetap membaca ref yang SAMA dengan yang ditulis di sana.
  const { onSelect, onFocus, closeSession, onRenameWorkspace, onDeleteWorkspace, onCreateWorkspace, onNewProject } =
    useWorkspaceLifecycle({
      workspaces, activeId, applyWorkspace, scheduleSave, recordClosed,
      setWorkspaces, setActiveWs, setHydrated, setAuthRequired, setNodes, setEdges, setBoard, setPicker,
      activeWsRef, nodesRef, edgesRef, cancelSave, rf,
    })

  // Notification click → `onFocus`, which switches workspace when the node lives on another board.
  useEffect(() => setNotifyCanvas({ focus: (id) => void onFocus(id) }), [onFocus])

  const { onLogin, onLogout } = useAuthActions()

  // Lewat `onNodesChange`, bukan setNodes langsung: riwayat & persistensi menggantung di sana.
  const onSelectAll = useCallback(() => {
    onNodesChange(nodesRef.current.map((n) => ({ type: 'select' as const, id: n.id, selected: true })))
  }, [onNodesChange])

  const { onPaneContextMenu, menu: paneMenu } = useCanvasPaneMenu({
    rf, settings, nodeCount: nodes.length, onAddTerminal, onAddFiles, onAddBrowser, onAddAgent, onFit, onSelectAll,
  })

  const nodeColor = useCallback((n: Node) => miniMapNodeColor(n, statuses), [statuses])

  const agentSummary = useAgentSummary(statuses)

  // TIDAK ada suntikan apa pun ke `data` di sini — callback lewat `useNodeActions`, settings lewat
  // `useLiveSettings`. Node terminal/agent jadi mewarisi identitas objek aslinya (`withLinkHandles`
  // memulangkan `n` itu sendiri kecuali files/editor), satu-satunya cara `memo` menggigit saat drag.
  const flowNodes = useMemo(() => nodes.map(withLinkHandles), [nodes])

  const liveNodes = useMemo(() => nodes.map(toWsNode), [nodes])

  const displayEdges = useMemo(() => decorateEdges(edges, nodes), [edges, nodes])

  const noWorkspaces = workspaces.length === 0

  const inboxReady = hydrated && !noWorkspaces
  const { inboxUnread, outputStatusItems, outputCommands } = useDockFeeds(inboxOpen, setInboxOpen, inboxReady)

  // Gerbang auth: board tak pernah dirender sebelum token cocok. Di LUAR SettingsProvider tak apa —
  // Login tidak membaca settings. Sesudah semua hook, jadi urutan hook App tetap stabil antar render.
  if (authRequired) return <div className="app-shell app-shell--auth"><Login onSubmit={onLogin} /></div>

  return (
    <SettingsProvider value={settings}>
    <NodeActionsProvider value={nodeActions}>
    <div className={`app-shell${sessionsOpen && hydrated && !noWorkspaces ? ' app-shell--sidebar' : ''}`}>
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
        onOpenSettings={() => setShowSettings(true)}
        onOpenHelp={() => setShowHelp(true)}
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
          <BoardCanvas
            key={activeId ?? 'empty'}
            rf={rf}
            nodes={flowNodes}
            edges={displayEdges}
            settings={settings}
            viewport={activeWs?.viewport}
            locked={locked}
            nodeColor={nodeColor}
            syncViewport={syncViewport}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onMoveEnd={onMoveEnd}
            onPaneContextMenu={onPaneContextMenu}
          />
        )}
        {/* Cluster kontrol editor (palette ⌘K, Explorer, Settings, Help) hidup DI DALAM sel
            editor, bukan mengapung di atas tab bar: `top`-nya jadi jarak dari canvas. */}
        <CanvasToolbar
          nodes={flowNodes}
          onFocusNode={onFocus}
          onOpenExplorer={onAddFiles}
          onOpenSettings={() => setShowSettings(true)}
          onOpenHelp={() => setShowHelp(true)}
          commands={outputCommands}
        />
      </div>
      {hydrated && !noWorkspaces && (
        <>
          <Dock
            onAddTerminal={onAddTerminal}
            onAddBrowser={onAddBrowser}
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
            boardOpen={board}
            sessionsOpen={sessionsOpen}
            onToggleSessions={() => setSessionsOpen((v) => !v)}
            inboxOpen={inboxOpen}
            onToggleInbox={() => setInboxOpen(!inboxOpen)}
            inboxUnread={inboxUnread}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen(!chatOpen)}
            centralOpen={central.open}
            onToggleCentral={central.enabled ? central.toggle : undefined}
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
            workspaceName={activeWs?.name}
            agentSummary={agentSummary}
            onOpenSettings={() => setShowSettings(true)}
            extraStatusItems={outputStatusItems}
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
          <SessionHistory open={sessionsOpen} activeWs={activeWs} workspaces={workspaces} launch={settings.agentLaunchCommands} deps={{ activeId, addNode: addFlowNode, setWorkspaces, selectWorkspace: onSelect }} />
          {/* Panel menutup sendiri lewat Escape (`onClose`), dan dialog persetujuan di dalamnya
              yang memegang consent. Dock/badge tidak pernah menyetujui apa pun. */}
          <InboxPanel open={inboxOpen} onClose={() => setInboxOpen(false)} pollMs={30000} />
          {/* Panel menutup sendiri lewat tombol X-nya. Saat Inbox terbuka, Chat minggir ke kiri
              supaya dua permukaan itu tidak saling menimpa. */}
          <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} offsetForInbox={inboxOpen} />
          <CentralControlPanel open={central.open} onClose={central.close} enabled={central.enabled} />
          <OutputPanelHost />
          {board && <Kanban nodes={flowNodes} statuses={statuses} onFocus={onFocus} onClose={() => setBoard(false)} />}
          {paneMenu}
          <BrowserLinkOfferHost />
        </>
      )}
      {/* Di luar blok `hydrated && !noWorkspaces`: chord-nya tidak digerbangi apa pun, jadi
          petunjuk jalan keluarnya juga tidak boleh. */}
      {cleanView && <CleanViewHint />}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
      {showSettings && <SettingsPanel settings={settings} onChange={update} onClose={() => setShowSettings(false)} projectId={activeId ?? undefined} />}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
    </NodeActionsProvider>
    </SettingsProvider>
  )
}