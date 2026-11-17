// The chrome around a loaded board (App renders it only once hydrated with at least one workspace):
// Dock, side bar, bottom panel, secondary side bar, hosts and overlays. State stays in App; this file
// only lays it out, so App.tsx stays the owner of every hook and its order.
import { lazy, Suspense, type ComponentProps, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { Edge, Node } from '@xyflow/react'
import AppDock from './App.chrome'
import SessionsPanel from './SessionsPanel'
import SideBar from './sideBar/SideBar'
import type { useAppSideBar } from './sideBar/useAppSideBar'
import AppBottomPanel from './App.bottomPanel'
import SecondarySideBar from './App.secondarySideBar'
import OutputPanelHost from './output/outputPanelHost'
import type { useProblems } from './ProblemsPanel'
import MorningBrief from './MorningBrief'
import type { toWsNode } from './store'
import type { useWorkspaceLifecycle } from './workspaceLifecycle'
import type { ReopenDeps, useClosedHistory } from './closedHistory'
import SessionHistory from './SessionHistory'
import SkillPalette from './SkillPalette'
import type { useBoardActions } from './App.board'
import LayersPanel from './layersPanel'
import type { useAppTabs } from './App.tabs'
import AppHosts from './App.hosts'
import type { useStatusReasons } from './App.hooks'
import type { useAppUrlState } from './App.route'
import type { AgentStatus, Workspace } from '../shared/workspace'

// Rarely opened overlay: loads on first open, not with the board (keeps the start-up chunk small).
const Kanban = lazy(() => import('./Kanban'))

type Lifecycle = ReturnType<typeof useWorkspaceLifecycle>
type Board = ReturnType<typeof useBoardActions>
type Closed = ReturnType<typeof useClosedHistory>
type UrlState = ReturnType<typeof useAppUrlState>

/** Everything the workbench shows; all of it is owned by App. */
export interface AppWorkbenchProps {
  dock: ComponentProps<typeof AppDock>
  sideBar: ReturnType<typeof useAppSideBar>
  tabsProps: ReturnType<typeof useAppTabs>
  rf: ComponentProps<typeof LayersPanel>['rf']
  flowNodes: Node[]
  nodes: Node[]
  edges: Edge[]
  nodesRef: ComponentProps<typeof AppBottomPanel>['nodesRef']
  statuses: Record<string, AgentStatus>
  statusReasons: ReturnType<typeof useStatusReasons>
  workspaces: Workspace[]
  activeWs: Workspace | null
  activeId: string | null
  liveNodes: ReturnType<typeof toWsNode>[]
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
  onFocus: Lifecycle['onFocus']
  onSelect: Lifecycle['onSelect']
  closeSession: Lifecycle['closeSession']
  addFlowNode: Board['addFlowNode']
  restoreBridges: Board['restoreBridges']
  onAddDiff: Board['onAddDiff']
  closedSessions: Closed['entries']
  reopenClosed: Closed['reopen']
  reopenDeps: ReopenDeps
  problems: ReturnType<typeof useProblems>
  tasksMenu: ReactNode
  centralEnabled: boolean
  route: UrlState['route']
  setCentralTab: UrlState['actions']['setCentralTab']
  board: boolean
  setBoard: UrlState['setBoard']
  paneMenu: ReactNode
}

export default function AppWorkbench(p: AppWorkbenchProps) {
  const { sideBar, tabsProps, activeWs, activeId, statuses, onFocus, onSelect, reopenClosed, reopenDeps, addFlowNode } = p
  return (
    <>
      <AppDock {...p.dock} />
      <SideBar
        open={sideBar.open} view={sideBar.view} onClose={() => sideBar.setOpen(false)} layerCount={p.flowNodes.length}
        layers={activeWs ? <LayersPanel nodes={tabsProps.nodes} statuses={statuses} rf={p.rf} onCloseNode={tabsProps.onCloseNode} onRenameNode={tabsProps.onRenameNode} onAddTerminal={tabsProps.onAddTerminal} onAddAgent={tabsProps.onAddAgent} /> : null}
        sessions={<SessionsPanel
          active={sideBar.open && sideBar.view === 'sessions'} workspaces={p.workspaces} activeId={activeId} liveActiveNodes={p.liveNodes} statuses={statuses} reasons={p.statusReasons}
          onFocusNode={onFocus} onCloseSession={(id) => void p.closeSession(id)} onSelectWorkspace={(id) => void onSelect(id)}
          closedSessions={p.closedSessions} onReopenSession={(id) => void reopenClosed(id, reopenDeps)}
          onRenameNode={tabsProps.onRenameNode} onAddTerminal={tabsProps.onAddTerminal} onAddAgent={tabsProps.onAddAgent} />}
        history={<SessionHistory active={sideBar.open && sideBar.view === 'history'} activeWs={activeWs} workspaces={p.workspaces} deps={{ activeId, addNode: addFlowNode, setWorkspaces: p.setWorkspaces, selectWorkspace: onSelect }} />}
        skills={<SkillPalette nodes={p.nodes} edges={p.edges} />}
      />
      {/* Problems, Activity, dan Output satu permukaan bertab: tepat satu view tampil. Panel
          menutup lewat Escape/X tab-nya. Persetujuan tinggal di strip Needs-you chat Central. */}
      <AppBottomPanel
        problems={p.problems} root={activeWs?.cwd} nodes={p.nodes} nodesRef={p.nodesRef} addFlowNode={addFlowNode}
        onFocus={(id) => void onFocus(id)}
        workspaces={p.workspaces} liveNodes={p.liveNodes} activeId={activeId} centralEnabled={p.centralEnabled} panel={p.route.panel} />
      {/* Chat & Central di kanan (ala Copilot Chat): kolom grid `aux`, canvas menyempit, tidak ditutupi. */}
      <SecondarySideBar centralEnabled={p.centralEnabled} ctab={p.route.ctab} setCentralTab={p.setCentralTab} />
      <OutputPanelHost />
      {p.tasksMenu}
      <MorningBrief onFocusNode={(id) => void onFocus(id)} onOpenDiff={(ws) => (ws === activeId ? p.onAddDiff() : void onSelect(ws))} onOpenWorkspace={(ws) => void onSelect(ws)} />
      <AppHosts
        activeWs={activeWs}
        onCreated={(ws) => { p.setWorkspaces((prev) => [ws, ...prev.filter((w) => w.id !== ws.id)]); void onSelect(ws.id) }}
        onPlace={(placed, bridges) => { for (const n of placed) addFlowNode(() => n); p.restoreBridges(bridges, placed.map((n) => n.id)) }}
      />
      {p.board && <Suspense fallback={null}><Kanban nodes={p.flowNodes} statuses={statuses} onFocus={onFocus} onClose={() => p.setBoard(false)} /></Suspense>}
      {p.paneMenu}
    </>
  )
}
