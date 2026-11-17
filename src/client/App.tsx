import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react'
import { useRememberLastResize } from './nodeSpawn'
import '@xyflow/react/dist/style.css'
import { AppWorkspaceBar } from './App.chrome'
import AppWorkbench from './App.workbench'
import FolderPicker from './FolderPicker'
import Welcome from './Welcome'
import AppSetup from './App.setup'
import SignInScreen from './SignInScreen'
import BootScreen from './BootScreen'
import ConnectionStatus from './ConnectionStatus'
import { useAppSideBar, useSessionsAttention } from './sideBar/useAppSideBar'
import { toggleSideBar, toggleSideBarView } from './secondarySideBar.store'
import { useCentralControlEnabled } from './central/centralControlApi'
import { CleanViewHint, useCleanView } from './cleanView'
import Omnibox from './Omnibox'
import { openEditorAt, useOmnibox } from './Omnibox.open'
import { setLspFileOpener } from './editorLsp.store'
import { useAppCommands } from './commandRegistry.defaults'
import { TASK_BOARD_STATUS_ITEM } from './central/work/taskBoardView'
import { usePortsStatusItems } from './PortsChip'
import { useProblems } from './ProblemsPanel'
import { useTasksMenu } from './TasksMenu'
import { SettingsProvider, SettingsUpdateProvider, useSettings } from './useSettings'
import { NodeActionsProvider } from './nodeActions'
import { ActiveWorkspaceProvider } from './activeWorkspace.context'
import { toWsNode } from './store'
import { useBoardNodeNames } from './nodeNames.board'
import { useCanvasPaneMenu } from './canvasMenu.pane'
import { decorateEdges, miniMapNodeColor, withLinkHandles } from './canvasStyle'
import { useCanvasViewport } from './canvasViewport'
import { setNotifyCanvas } from './osNotify'
import { useLayoutHistory } from './layoutHistory'
import { useWorkspaceLifecycle } from './workspaceLifecycle'
import { useWorkspaceSaver } from './workspaceSaver'
import { useClosedHistory, type ReopenDeps } from './closedHistory'
import { useCanvasUndo } from './canvasUndo'
import { useBoardActions } from './App.board'
import BoardHost from './BoardHost'
import { useLayersCommands } from './layers.commands'
import { useAppTabs } from './App.tabs'
import { toggleMaximizeTarget } from './nodeMaximize.store'
import { SettingsHost } from './App.hosts'
import { useStatusSubscription, useAppTheme, useAuthActions, useAgentSummary, useDockFeeds, useAppSession, useStatusReasons } from './App.hooks'
import { useAppUrlState, useWorkspaceUrlSync } from './App.route'
import { DEFAULT_VIEWPORT } from '../shared/workspace'
import type { AgentStatus, Viewport, Workspace } from '../shared/workspace'

// Rarely opened overlay: loads on first open, not with the board (keeps the start-up chunk small).
const HelpOverlay = lazy(() => import('./HelpOverlay'))

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // "Belum tahu" vs "memang tidak ada": sebelum fetch pertama selesai keduanya sama-sama daftar
  // kosong, dan `Welcome` yang dirender atas dasar itu selalu berkelebat sekejap.
  const [hydrated, setHydrated] = useState(false)
  // Dinaikkan saat boot fetch / simpanan board / socket menjawab 401/403: render SignInScreen, bukan board.
  const [authRequired, setAuthRequired] = useState(false)
  const requireSignIn = useCallback(() => setAuthRequired(true), [])
  const [activeWs, setActiveWs] = useState<Workspace | null>(null)
  // Diturunkan, bukan state sendiri: id dan board-nya pernah di-commit terpisah, dan tiap jeda
  // antara keduanya adalah satu render dengan canvas yang sudah pindah tapi datanya belum ada.
  const activeId = activeWs?.id ?? null
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({})
  const [picker, setPicker] = useState<{ onPick: (p: string) => void } | null>(null)
  const { route, actions: routeActions, board, setBoard, setShowSettings, showHelp, setShowHelp } = useAppUrlState() // overlays live in the URL (./appRoute)
  const [locked, setLocked] = useState(false)
  // Di App, bukan di dalam side bar: ikon view-nya (Layers/Sessions/History) ada di Dock.
  const sideBar = useAppSideBar()
  // Chat & Central tinggal di secondary side bar kanan; buka/tutup & view-nya milik
  // `secondarySideBar.store` (dibaca Dock, title bar, dan side bar itu sendiri), bukan state App.
  const centralEnabled = useCentralControlEnabled()
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
  useLayersCommands(rf) // Group / Ungroup (Mod+G / Mod+Shift+G) for the Layers side bar

  useStatusSubscription(setStatuses)
  useAppTheme(settings)

  // Payload dikunci di `scheduleSave`, bukan dibaca ulang saat timer menembak: board bisa berpindah
  // workspace dalam 400ms debounce. Lihat `useWorkspaceSaver` — termasuk kenapa `flushSave` wajib
  // dipanggil `applyWorkspace` sebelum board baru dipasang.
  const applyRef = useRef<((ws: Workspace) => void) | null>(null) // set below, once `applyWorkspace` exists
  const { scheduleSave, flushSave, cancelSave, saveStatusItems } = useWorkspaceSaver({ activeWsRef, nodesRef, edgesRef, viewportRef, saveTimer, applyRef, setWorkspaces, onAuthRequired: requireSignIn })

  // Batalkan simpanan menggantung saat unmount: tanpa ini timer menembak PUT setelah App hilang —
  // di test lewat `fetch` yang stub-nya sudah dicabut (rejection liar, flaky antar test).
  useEffect(() => () => cancelSave(), [cancelSave])

  // Concern viewport — readout zoom, zoom/fit, riwayat pandangan. Lihat `./canvasViewport`:
  // `viewportRef` dipinjam ke sana, jadi `scheduleSave` di atas mem-persist viewport yang
  // ditulis hook itu, bukan salinan yang sudah basi. Dideklarasikan SEBELUM `applyWorkspace`
  // karena pemasangan board memanggil `resetViewport`.
  const vp = useCanvasViewport({ rf, viewportRef, scheduleSave })
  const { syncViewport, onMoveEnd, onFit, onZoomTo, onPanBy, resetViewport } = vp

  // Undo/redo layout node — tumpukan terpisah dari riwayat pandangan di atas. Lihat `./layoutHistory`.
  const { onUndo: onLayoutUndo, onRedo, canUndo: canLayoutUndo, canRedo, pushLayout, resetLayout } =
    useLayoutHistory({ nodesRef, setNodes, scheduleSave })

  const {
    applyWorkspace, onNodesChange, onConnect, onEdgesChange, addFlowNode, restoreBridges, onAddTerminal, onAddFiles, onAddDiff, onAddBrowser, onAddAgent, onAddAgentChat, onAddSkill, nodeActions,
  } = useBoardActions({
    rf, activeWsRef, nodesRef, edgesRef, settings, activeId, browserReady: hydrated && !authRequired,
    setActiveWs, setNodes, setEdges, flushSave, scheduleSave, resetViewport, resetLayout, pushLayout, recordClosed,
  })
  applyRef.current = applyWorkspace // a save another window beat reloads the stored board through it
  // Every node gets its unique name ("Mango") here, whichever path created it. See `./nodeNames.board`.
  useBoardNodeNames(nodes, onNodesChange)
  const onCanvasNodesChange = useRememberLastResize(onNodesChange, update) // next new node = last resize

  // Siklus hidup workspace — board MANA yang dibuka (boot, pindah tab, rename, hapus, buat) plus
  // aksi sesi lintas-workspace. Lihat `./workspaceLifecycle`: ref & setter dipinjam apa adanya,
  // jadi `scheduleSave` dan canvas tetap membaca ref yang SAMA dengan yang ditulis di sana.
  const { onSelect, onFocus, closeSession, onRenameWorkspace, onDeleteWorkspace, onCreateWorkspace, onCreateReported, onNewProject, boot, retryBoot } =
    useWorkspaceLifecycle({
      workspaces, activeId, applyWorkspace, scheduleSave, recordClosed,
      setWorkspaces, setActiveWs, setHydrated, setAuthRequired, setNodes, setEdges, setBoard, setPicker,
      activeWsRef, nodesRef, edgesRef, cancelSave, rf, onFit, onZoomTo, onPanBy, urlWorkspaceId: route.workspaceId,
    })
  useWorkspaceUrlSync({ urlWorkspaceId: route.workspaceId, activeId, hydrated, workspaces, onSelect, goWorkspace: routeActions.goWorkspace })

  // Notification click → `onFocus`, which switches workspace when the node lives on another board
  // (found in `workspaces`, kept current by every save and switch).
  useEffect(() => setNotifyCanvas({ focus: (id) => void onFocus(id) }), [onFocus])

  const reopenDeps: ReopenDeps = { activeId, addNode: addFlowNode, setWorkspaces, selectWorkspace: onSelect, addBridges: restoreBridges }
  // Undo = layout undo + reopen-closed (with cables, across reloads). See `./canvasUndo`.
  const { onUndo, canUndo } = useCanvasUndo({
    nodesRef, layout: { onUndo: onLayoutUndo, canUndo: canLayoutUndo }, closed: closedSessions,
    bridgesOf: closedBridgesOf, reopen: reopenClosed, reopenDeps, restoreBridges,
  })

  const { signedIn, onLogout } = useAuthActions()

  // Lewat `onNodesChange`, bukan setNodes langsung: riwayat & persistensi menggantung di sana.
  const onSelectAll = useCallback(() => {
    onNodesChange(nodesRef.current.map((n) => ({ type: 'select' as const, id: n.id, selected: true })))
  }, [onNodesChange])

  const { onPaneContextMenu, menu: paneMenu } = useCanvasPaneMenu({
    rf, settings, nodeCount: nodes.length, onAddTerminal, onAddFiles, onAddDiff, onAddBrowser, onAddAgent, onAddAgentChat, onAddSkill, onFit, onSelectAll,
  })

  const nodeColor = useCallback((n: Node) => miniMapNodeColor(n, statuses), [statuses])

  const agentSummary = useAgentSummary(statuses)
  // Mounted with App (not the Sessions view, which mounts only while shown) so no reason frame is missed.
  const statusReasons = useStatusReasons()

  // TIDAK ada suntikan apa pun ke `data` di sini — callback lewat `useNodeActions`, settings lewat
  // `useLiveSettings`. Node terminal/agent jadi mewarisi identitas objek aslinya (`withLinkHandles`
  // memulangkan `n` itu sendiri kecuali files/editor), satu-satunya cara `memo` menggigit saat drag.
  const flowNodes = useMemo(() => nodes.map(withLinkHandles), [nodes])

  // Tab mode's props + layout commands; closing a tab takes the same path as NodeChrome's close.
  const tabsProps = useAppTabs({
    activeId, rf, nodes: flowNodes, statuses, settings, closeNode: (id) => void closeSession(id),
    onAddTerminal, onAddFiles, onAddDiff, onAddBrowser, onAddAgent, onAddAgentChat,
  })

  const liveNodes = useMemo(() => nodes.map(toWsNode), [nodes])

  const displayEdges = useMemo(() => decorateEdges(edges, nodes, settings.edgeWidth), [edges, nodes, settings.edgeWidth])

  const noWorkspaces = workspaces.length === 0

  const { needsYouCount, outputStatusItems, outputCommands } = useDockFeeds()
  const sessionsAttention = useSessionsAttention(workspaces, liveNodes, activeId, statuses)
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
    toggleMaximizeNode: () => toggleMaximizeTarget(nodesRef.current),
    toggleSessions: () => sideBar.setOpen((v) => !v), toggleChat: () => toggleSideBarView('chat'), toggleSecondarySideBar: toggleSideBar,
    toggleBoard: () => setBoard((v) => !v),
  })
  useAppSession(!authRequired, settings, settingsHydrated, update)

  // Gerbang auth: board tak pernah dirender sebelum token cocok. Di LUAR SettingsProvider tak apa —
  // SignInScreen tidak membaca settings. Sesudah semua hook, jadi urutan hook App tetap stabil antar render.
  if (authRequired) return <div className="app-shell app-shell--auth"><SignInScreen /></div>

  return (
    <SettingsProvider value={settings}>
    <SettingsUpdateProvider value={update}>
    <NodeActionsProvider value={nodeActions}>
    <ActiveWorkspaceProvider value={activeId}>
    <div className={`app-shell${sideBar.open && hydrated && !noWorkspaces ? ' app-shell--sidebar' : ''}`}>
      {/* Header dirender SELALU — juga di layar Welcome: tombol `+`-nya adalah jalan masuk yang
          sama, dan header yang baru muncul setelah workspace pertama akan menggeser canvas
          46px ke bawah tepat saat pengguna menekan tombol. Lihat catatan di WorkspaceBar. */}
      <AppWorkspaceBar {...{ workspaces, activeId, liveNodes, statuses, onSelect, onNewProject, onRenameWorkspace, onDeleteWorkspace, onLogout, showLogout: signedIn, onOpenAccount: () => routeActions.openSettings('account'), onAddFiles, omni, setShowSettings, setShowHelp }} />
      {/* Satu-satunya pembawa tinggi canvas; `Welcome` (position: absolute; inset: 0) dan
          ReactFlow sama-sama mengisinya. Panel mengapung TIDAK ikut masuk ke sini: `top`-nya
          dihitung dari atas viewport lewat --tabbar-h/--ss-top-chrome, jadi menaruhnya di dalam
          .app-main akan menghitung tinggi header dua kali. */}
      <div className="app-main">
        {!hydrated ? <BootScreen boot={boot} onRetry={retryBoot} /> : noWorkspaces ? (
          <Welcome
            onNewProject={onNewProject} onCreateEmpty={(name) => void onCreateReported(name)} setup={settingsHydrated ? settings.setup : undefined}
            closedSessions={closedSessions} onReopen={(id) => void reopenClosed(id, reopenDeps)}
          />
        ) : (
          <BoardHost
            key={activeId ?? 'empty'}
            tabs={tabsProps}
            canvas={{
              rf, nodes: flowNodes, edges: displayEdges, settings, hydrated: settingsHydrated, viewport: activeWs?.viewport, locked, nodeColor,
              syncViewport, onNodesChange: onCanvasNodesChange, onEdgesChange, onConnect, onMoveEnd, onPaneContextMenu,
            }}
          />
        )}
      </div>
      {hydrated && !noWorkspaces && (
        <AppWorkbench
          dock={{
            vp, settings, activeWs, board, setBoard, sideBar, sessionsAttention, locked, setLocked, cleanView, toggleCleanView, setPicker, setShowSettings,
            onAddTerminal, onAddBrowser, onAddAgent, onCreateWorkspace, onUndo, onRedo, canUndo, canRedo, needsYouCount, agentSummary,
            extraStatusItems: [...saveStatusItems, ...outputStatusItems, ...(centralEnabled ? [TASK_BOARD_STATUS_ITEM] : []), ...portItems, ...problems.statusItems, ...tasks.statusItems],
          }}
          {...{ sideBar, tabsProps, rf, flowNodes, nodes, nodesRef, statuses, statusReasons, workspaces, activeWs, activeId, liveNodes, setWorkspaces, onFocus, onSelect, closeSession }}
          {...{ addFlowNode, restoreBridges, onAddDiff, closedSessions, reopenClosed, reopenDeps, problems, centralEnabled, route, board, setBoard, paneMenu }}
          tasksMenu={tasks.menu} setCentralTab={routeActions.setCentralTab}
        />
      )}
      {/* Di luar blok `hydrated && !noWorkspaces`: chord-nya tak digerbangi, petunjuk keluarnya juga tidak. */}
      {cleanView && <CleanViewHint />}
      <ConnectionStatus onAuthRequired={requireSignIn} />{/* one app-wide surface; `auth` reuses the boot gate above */}
      {picker && <FolderPicker onPick={(p) => { picker.onPick(p); setPicker(null) }} onClose={() => setPicker(null)} />}
      {/* `hydrated` too: the wizard must never cover BootScreen (a failed boot and its Retry). */}
      <AppSetup settings={settings} update={update} hydrated={settingsHydrated && hydrated} />
      <SettingsHost section={route.settings} field={route.field} onOpen={routeActions.openSettings} onClose={routeActions.closeSettings} settings={settings} onChange={update} projectId={activeId ?? undefined} workspaces={workspaces} history={settingsHistory} />
      {showHelp && <Suspense fallback={null}><HelpOverlay onClose={() => setShowHelp(false)} /></Suspense>}
      {omni.state && (
        <Omnibox
          key={`${omni.state.scope}:${omni.state.initialQuery}`} scope={omni.state.scope} initialQuery={omni.state.initialQuery}
          root={activeWs?.cwd} sources={omni.sources} onAction={omni.onAction} onClose={omni.close}
        />
      )}
    </div>
    </ActiveWorkspaceProvider>
    </NodeActionsProvider>
    </SettingsUpdateProvider>
    </SettingsProvider>
  )
}