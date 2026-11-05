import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import AppDock, { AppWorkspaceBar } from './App.chrome'
import Kanban from './Kanban'
import FolderPicker from './FolderPicker'
import Welcome from './Welcome'
import Login from './Login'
import SessionsPanel, { useSessionsOpen } from './SessionsPanel'
import AppBottomPanel from './App.bottomPanel'
import { toggleBottomView } from './bottomPanelHost'
import { useChatOpen } from './ChatPanel'
import CentralControlPanel, { useCentralControl } from './central/CentralControlPanel'
import { useInboxOpen } from './inboxPanelModel'
import { CleanViewHint, useCleanView } from './cleanView'
import HelpOverlay from './HelpOverlay'
import Omnibox from './Omnibox'
import { openEditorAt, useOmnibox } from './Omnibox.open'
import { setLspFileOpener } from './editorLsp.store'
import { useAppCommands } from './commandRegistry.defaults'
import { useCommandKeybindings } from './commandRegistry'
import { useKeybindingsSync } from './keybindings.store'
import { usePresencePing } from './presencePing'
import OutputPanelHost from './output/outputPanelHost'
import { usePortsStatusItems } from './PortsChip'
import { useProblems } from './ProblemsPanel'
import { useTasksMenu } from './TasksMenu'
import MorningBrief from './MorningBrief'
import { SettingsProvider, useSettings } from './useSettings'
import { NodeActionsProvider } from './nodeActions'
import { toWsNode } from './store'
import { useCanvasPaneMenu } from './canvasMenu.pane'
import { decorateEdges, miniMapNodeColor, withLinkHandles } from './canvasStyle'
import { useCanvasViewport } from './canvasViewport'
import { setNotifyCanvas } from './osNotify'
import { useLayoutHistory } from './layoutHistory'
import { useWorkspaceLifecycle, useWorkspaceSaver } from './workspaceLifecycle'
import { useClosedHistory, type ReopenDeps } from './closedHistory'
import { useCanvasUndo } from './canvasUndo'
import SessionHistory from './SessionHistory'
import { useBoardActions } from './App.board'
import BoardHost from './BoardHost'
import { useAppTabs } from './App.tabs'
import AppHosts, { SettingsHost } from './App.hosts'
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
  const { settings, update, history: settingsHistory, hydrated: settingsHydrated } = useSettings()
  const { entries: closedSessions, record: recordClosed, reopen: reopenClosed, bridgesOf: closedBridgesOf } = useClosedHistory(workspaces, nodes)

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
  const vp = useCanvasViewport({ rf, viewportRef, scheduleSave })
  const { syncViewport, onMoveEnd, onFit, resetViewport } = vp

  // Undo/redo layout node — tumpukan terpisah dari riwayat pandangan di atas. Lihat `./layoutHistory`.
  const { onUndo: onLayoutUndo, onRedo, canUndo: canLayoutUndo, canRedo, pushLayout, resetLayout } =
    useLayoutHistory({ nodesRef, setNodes, scheduleSave })

  const {
    applyWorkspace, onNodesChange, onConnect, onEdgesChange, addFlowNode, restoreBridges, onAddTerminal, onAddFiles, onAddDiff, onAddBrowser, onAddAgent, nodeActions,
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

  const reopenDeps: ReopenDeps = { activeId, addNode: addFlowNode, setWorkspaces, selectWorkspace: onSelect, addBridges: restoreBridges }
  // Undo = layout undo + reopen-closed (with cables, across reloads). See `./canvasUndo`.
  const { onUndo, canUndo } = useCanvasUndo({
    nodesRef, layout: { onUndo: onLayoutUndo, canUndo: canLayoutUndo }, closed: closedSessions,
    bridgesOf: closedBridgesOf, reopen: reopenClosed, reopenDeps, restoreBridges,
  })

  const { onLogin, onLogout } = useAuthActions()

  // Lewat `onNodesChange`, bukan setNodes langsung: riwayat & persistensi menggantung di sana.
  const onSelectAll = useCallback(() => {
    onNodesChange(nodesRef.current.map((n) => ({ type: 'select' as const, id: n.id, selected: true })))
  }, [onNodesChange])

  const { onPaneContextMenu, menu: paneMenu } = useCanvasPaneMenu({
    rf, settings, nodeCount: nodes.length, onAddTerminal, onAddFiles, onAddDiff, onAddBrowser, onAddAgent, onFit, onSelectAll,
  })

  const nodeColor = useCallback((n: Node) => miniMapNodeColor(n, statuses), [statuses])

  const agentSummary = useAgentSummary(statuses)

  // TIDAK ada suntikan apa pun ke `data` di sini — callback lewat `useNodeActions`, settings lewat
  // `useLiveSettings`. Node terminal/agent jadi mewarisi identitas objek aslinya (`withLinkHandles`
  // memulangkan `n` itu sendiri kecuali files/editor), satu-satunya cara `memo` menggigit saat drag.
  const flowNodes = useMemo(() => nodes.map(withLinkHandles), [nodes])

  // Tab mode's props + layout commands; closing a tab takes the same path as NodeChrome's close.
  const tabsProps = useAppTabs({
    activeId, rf, nodes: flowNodes, statuses, settings, closeNode: (id) => void closeSession(id),
    onAddTerminal, onAddFiles, onAddDiff, onAddBrowser, onAddAgent,
  })

  const liveNodes = useMemo(() => nodes.map(toWsNode), [nodes])

  const displayEdges = useMemo(() => decorateEdges(edges, nodes), [edges, nodes])

  const noWorkspaces = workspaces.length === 0

  const inboxReady = hydrated && !noWorkspaces
  const { inboxUnread, outputStatusItems, outputCommands } = useDockFeeds(inboxOpen, setInboxOpen, inboxReady)
  // Senses chips: detected ports, Problems counter, Run Task (src/server/ports|problems|tasks).
  const portItems = usePortsStatusItems(activeId, nodeActions.openBrowserAt)
  const problems = useProblems(activeId)
  const tasks = useTasksMenu(activeId, addFlowNode)
  // Go to Definition into a file no editor node shows opens one (editorLsp.monaco.ts).
  useEffect(() => setLspFileOpener((path, line, col) => openEditorAt({ nodesRef, addFlowNode, onFocus }, path, line, col)), [addFlowNode, onFocus])

  // ⌘K omnibox / ⌘P Go to File / ⇧⌘F Find in Files + the command registry behind them and Help.
  const omni = useOmnibox({
    root: activeWs?.cwd, nodes, nodesRef, settings, extraCommands: outputCommands, addFlowNode, onFocus, onAddAgent,
    openBrowserAt: nodeActions.openBrowserAt,
  })
  useAppCommands({
    openOmnibox: () => omni.open('all'), openQuickOpen: () => omni.open('files'), openFindInFiles: () => omni.open('files', '%'),
    openShortcuts: () => setShowHelp(true), openSettings: () => setShowSettings(true),
    newTerminal: () => onAddTerminal(), newFiles: () => onAddFiles(), newDiff: () => onAddDiff(), newBrowser: onAddBrowser && (() => onAddBrowser()), fitView: () => onFit(),
    toggleSessions: () => setSessionsOpen((v) => !v), toggleInbox: () => toggleBottomView('inbox', inboxOpen, setInboxOpen), toggleChat: () => toggleBottomView('chat', chatOpen, setChatOpen),
    toggleBoard: () => setBoard((v) => !v),
  })
  useKeybindingsSync(settings.keybindings, settingsHydrated, update)
  useCommandKeybindings()
  usePresencePing(!authRequired)

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
      <AppWorkspaceBar {...{ workspaces, activeId, liveNodes, statuses, onSelect, onNewProject, onRenameWorkspace, onDeleteWorkspace, onLogout, onAddFiles, omni, setShowSettings, setShowHelp }} />
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
            onReopen={(id) => void reopenClosed(id, reopenDeps)}
          />
        ) : (
          <BoardHost
            key={activeId ?? 'empty'}
            tabs={tabsProps}
            canvas={{
              rf, nodes: flowNodes, edges: displayEdges, settings, hydrated: settingsHydrated, viewport: activeWs?.viewport, locked, nodeColor,
              syncViewport, onNodesChange, onEdgesChange, onConnect, onMoveEnd, onPaneContextMenu,
            }}
          />
        )}
      </div>
      {hydrated && !noWorkspaces && (
        <>
          <AppDock
            {...{ vp, settings, activeWs, central, board, setBoard, sessionsOpen, setSessionsOpen, inboxOpen, setInboxOpen, chatOpen, setChatOpen, locked, setLocked, cleanView, toggleCleanView, setPicker, setShowSettings }}
            {...{ onAddTerminal, onAddBrowser, onAddAgent, onCreateWorkspace, onUndo, onRedo, canUndo, canRedo, inboxUnread, agentSummary }}
            extraStatusItems={[...outputStatusItems, ...portItems, ...problems.statusItems, ...tasks.statusItems]}
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
            onReopenSession={(id) => void reopenClosed(id, reopenDeps)}
          />
          <SessionHistory open={sessionsOpen} activeWs={activeWs} workspaces={workspaces} launch={settings.agentLaunchCommands} deps={{ activeId, addNode: addFlowNode, setWorkspaces, selectWorkspace: onSelect }} />
          {/* Inbox, Chat, Problems, dan Output satu permukaan bertab: tepat satu view tampil. Panel
              menutup lewat Escape/X tab-nya; dialog persetujuan Inbox yang memegang consent. */}
          <AppBottomPanel inboxOpen={inboxOpen} setInboxOpen={setInboxOpen} chatOpen={chatOpen} setChatOpen={setChatOpen}
            problems={problems} root={activeWs?.cwd} nodes={nodes} nodesRef={nodesRef} addFlowNode={addFlowNode}
            onFocus={(id) => void onFocus(id)} />
          <CentralControlPanel open={central.open} onClose={central.close} enabled={central.enabled} />
          <OutputPanelHost />
          {tasks.menu}
          <MorningBrief onFocusNode={(id) => void onFocus(id)} onOpenInbox={() => setInboxOpen(true)} onOpenDiff={(ws) => (ws === activeId ? onAddDiff() : void onSelect(ws))} onOpenWorkspace={(ws) => void onSelect(ws)} />
          <AppHosts
            workspaces={workspaces} liveNodes={liveNodes} activeWs={activeWs} onFocusNode={(id) => void onFocus(id)}
            onCreated={(ws) => { setWorkspaces((prev) => [ws, ...prev.filter((w) => w.id !== ws.id)]); void onSelect(ws.id) }}
            onPlace={(placed, bridges) => { for (const n of placed) addFlowNode(() => n); restoreBridges(bridges, placed.map((n) => n.id)) }}
          />
          {board && <Kanban nodes={flowNodes} statuses={statuses} onFocus={onFocus} onClose={() => setBoard(false)} />}
          {paneMenu}
        </>
      )}
      {/* Di luar blok `hydrated && !noWorkspaces`: chord-nya tidak digerbangi apa pun, jadi
          petunjuk jalan keluarnya juga tidak boleh. */}
      {cleanView && <CleanViewHint />}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
      <SettingsHost open={showSettings} setOpen={setShowSettings} settings={settings} onChange={update} projectId={activeId ?? undefined} history={settingsHistory} />
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {omni.state && (
        <Omnibox
          key={`${omni.state.scope}:${omni.state.initialQuery}`} scope={omni.state.scope} initialQuery={omni.state.initialQuery}
          root={activeWs?.cwd} sources={omni.sources} onAction={omni.onAction} onClose={omni.close}
        />
      )}
    </div>
    </NodeActionsProvider>
    </SettingsProvider>
  )
}