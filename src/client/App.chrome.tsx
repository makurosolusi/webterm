import type { Dispatch, SetStateAction } from 'react'
import Dock from './Dock'
import WorkspaceBar from './WorkspaceBar'
import type { DockProps } from './Dock'
import type { WorkspaceBarProps } from './WorkspaceBar'
import type { useOmnibox } from './Omnibox.open'
import type { CanvasViewport } from './canvasViewport'
import type { Settings } from '../shared/settings'
import type { Workspace } from '../shared/workspace'
import { useTabLayout } from './tabLayout.store'
import { toggleLayoutMode } from './tabLayout.commands'
import { toggleChatView, toggleSideBarView, useSideBar } from './secondarySideBar.store'
import { SecondarySideBarToggle, shownSideBarView } from './App.secondarySideBar'

type Toggle = Dispatch<SetStateAction<boolean>>

type PassThrough = 'onAddTerminal' | 'onAddBrowser' | 'onAddAgent' | 'onCreateWorkspace' | 'onUndo' | 'onRedo' | 'canUndo' | 'canRedo' | 'needsYouCount' | 'agentSummary' | 'extraStatusItems'

export interface AppDockProps extends Pick<DockProps, PassThrough> {
  vp: CanvasViewport
  settings: Settings
  activeWs: Workspace | null
  /** Central capability flag: off = the Dock's Central icon offers to turn it on. */
  centralEnabled: boolean
  board: boolean
  setBoard: Toggle
  sessionsOpen: boolean
  setSessionsOpen: Toggle
  locked: boolean
  setLocked: Toggle
  cleanView: boolean
  toggleCleanView: () => void
  setPicker: (picker: { onPick: (p: string) => void } | null) => void
  setShowSettings: (open: boolean) => void
}

/** Dock wired to App's state: its toggles, canvas viewport controls, and status-bar chips. */
export default function AppDock({
  vp, settings, activeWs, centralEnabled, board, setBoard, sessionsOpen, setSessionsOpen, locked, setLocked, cleanView, toggleCleanView, setPicker, setShowSettings, ...pass
}: AppDockProps) {
  const side = useSideBar()
  const sideShown = side.open ? shownSideBarView(side.view, centralEnabled) : null
  return (
    <Dock
      {...pass}
      onBrowse={(onPick) => setPicker({ onPick })}
      onBack={vp.onBack}
      onForward={vp.onForward}
      canBack={vp.canBack}
      canForward={vp.canForward}
      onFit={vp.onFit}
      onToggleBoard={() => setBoard((v) => !v)}
      boardOpen={board}
      sessionsOpen={sessionsOpen}
      onToggleSessions={() => setSessionsOpen((v) => !v)}
      chatOpen={sideShown === 'chat'}
      onToggleChat={() => toggleChatView(pass.needsYouCount ?? 0)}
      centralOpen={sideShown === 'central'}
      onToggleCentral={centralEnabled ? () => toggleSideBarView('central') : undefined}
      zoomPct={Math.round(vp.zoom * 100)}
      onZoomIn={vp.onZoomIn}
      onZoomOut={vp.onZoomOut}
      onZoomTo={vp.onZoomTo}
      locked={locked}
      onToggleLock={() => setLocked((v) => !v)}
      cleanView={cleanView}
      onToggleCleanView={toggleCleanView}
      disabledAgents={settings.disabledAgents}
      customAgents={settings.customAgents}
      agentLaunchCommands={settings.agentLaunchCommands}
      workspaceName={activeWs?.name}
      onOpenSettings={() => setShowSettings(true)}
    />
  )
}

export interface AppWorkspaceBarProps
  extends Pick<WorkspaceBarProps, 'workspaces' | 'activeId' | 'statuses' | 'onSelect' | 'onLogout' | 'showLogout'> {
  liveNodes: WorkspaceBarProps['liveActiveNodes']
  onNewProject: WorkspaceBarProps['onNewWorkspace']
  onRenameWorkspace: (id: string, name: string) => Promise<unknown>
  onDeleteWorkspace: (id: string) => Promise<unknown>
  onAddFiles: () => void
  omni: ReturnType<typeof useOmnibox>
  setShowSettings: (open: boolean) => void
  setShowHelp: (open: boolean) => void
}

/** WorkspaceBar wired to App's workspace lifecycle and overlays. */
export function AppWorkspaceBar({
  liveNodes, onNewProject, onRenameWorkspace, onDeleteWorkspace, onAddFiles, omni, setShowSettings, setShowHelp, ...pass
}: AppWorkspaceBarProps) {
  const layoutMode = useTabLayout().mode
  return (
    <WorkspaceBar
      {...pass}
      liveActiveNodes={liveNodes}
      onNewWorkspace={onNewProject}
      onRenameWorkspace={(id, name) => void onRenameWorkspace(id, name)}
      onDeleteWorkspace={(id) => void onDeleteWorkspace(id)}
      onOpenSettings={() => setShowSettings(true)}
      onOpenHelp={() => setShowHelp(true)}
      onNewFiles={() => onAddFiles()}
      onOpenPalette={() => omni.open('all')}
      layoutMode={layoutMode}
      onToggleLayout={toggleLayoutMode}
      titleActions={pass.workspaces.length > 0 ? <SecondarySideBarToggle /> : undefined}
    />
  )
}
