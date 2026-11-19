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
import { toggleChatView, useSideBar } from './secondarySideBar.store'
import { SecondarySideBarToggle } from './App.secondarySideBar'
import { workspaceColorVar } from '../shared/workspaceColor'
import type { AppSideBar } from './sideBar/useAppSideBar'
import { useHeaderReveal } from './useHeaderReveal'
import { WorkspaceRail, type WorkspaceRailProps } from './WorkspaceRail'
import { RailAccount, RailLayout, RailMenu, type RailChromeProps } from './RailChrome'
import type { WorkspaceMenuProps } from './useWorkspaceMenus'
import { useWorkspaceNavCommands } from './workspaceNav.commands'
import type { HeaderMode } from './headerMode.store'

type Toggle = Dispatch<SetStateAction<boolean>>

type PassThrough = 'onOpenPalette' | 'onAddTerminal' | 'onAddBrowser' | 'onAddAgent' | 'onCreateWorkspace' | 'onUndo' | 'onRedo' | 'canUndo' | 'canRedo' | 'needsYouCount' | 'agentSummary' | 'extraStatusItems'

export interface AppDockProps extends Pick<DockProps, PassThrough> {
  vp: CanvasViewport
  settings: Settings
  activeWs: Workspace | null
  board: boolean
  setBoard: Toggle
  sideBar: Pick<AppSideBar, 'open' | 'view' | 'select'>
  sessionsAttention: number
  locked: boolean
  setLocked: Toggle
  cleanView: boolean
  toggleCleanView: () => void
  setPicker: (picker: { onPick: (p: string) => void } | null) => void
  setShowSettings: (open: boolean) => void
  /** Compact/Hidden header: the workspace tiles shown in the rail. Absent in Full (the header's tab strip shows them). */
  workspaceRail?: WorkspaceRailProps
  /** Compact/Hidden header: the menu, account and (Hidden) layout switch live in the rail. Absent in Full. */
  railChrome?: Omit<RailChromeProps, 'layoutMode'>
}

/** Dock wired to App's state: its toggles, canvas viewport controls, and status-bar chips. */
export default function AppDock({
  vp, settings, activeWs, board, setBoard, sideBar, sessionsAttention, locked, setLocked, cleanView, toggleCleanView, setPicker, setShowSettings, workspaceRail, railChrome, ...pass
}: AppDockProps) {
  const side = useSideBar()
  const layoutMode = useTabLayout().mode
  const chrome = railChrome && { ...railChrome, layoutMode }
  return (
    <Dock
      {...pass}
      workspaceGroup={workspaceRail && <WorkspaceRail {...workspaceRail} />}
      railMenu={chrome && <RailMenu {...chrome} />}
      railAccount={chrome && <RailAccount {...chrome} />}
      railLayout={chrome && <RailLayout {...chrome} />}
      onBrowse={(onPick) => setPicker({ onPick })}
      onBack={vp.onBack}
      onForward={vp.onForward}
      canBack={vp.canBack}
      canForward={vp.canForward}
      onFit={vp.onFit}
      onToggleBoard={() => setBoard((v) => !v)}
      boardOpen={board}
      sideBarOpen={sideBar.open}
      sideBarView={sideBar.view}
      onSideBarView={sideBar.select}
      sessionsAttention={sessionsAttention}
      // One door: the Central icon is lit while the side bar is open on either tab (Chat or Control).
      chatOpen={side.open}
      onToggleChat={() => toggleChatView(pass.needsYouCount ?? 0)}
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
      workspaceAccent={activeWs ? workspaceColorVar(activeWs.color, activeWs.colorShade) : undefined}
      onOpenSettings={() => setShowSettings(true)}
    />
  )
}

export interface AppWorkspaceBarProps
  extends Pick<WorkspaceBarProps, 'workspaces' | 'activeId' | 'statuses' | 'onSelect'> {
  liveNodes: WorkspaceBarProps['liveActiveNodes']
  /** The File / View / Help inputs, shared with the rail's menu button (`chromeMenuProps`). */
  menu: WorkspaceMenuProps
  onRenameWorkspace: (id: string, name: string) => Promise<unknown>
  onSetWorkspaceColor: WorkspaceBarProps['onSetWorkspaceColor']
  omni: ReturnType<typeof useOmnibox>
  /** Effective header mode (`useEffectiveHeaderMode`). */
  headerMode: HeaderMode
}

/** WorkspaceBar wired to App's workspace lifecycle and overlays. */
export function AppWorkspaceBar({ liveNodes, menu, onRenameWorkspace, onSetWorkspaceColor, omni, headerMode, ...pass }: AppWorkspaceBarProps) {
  const layoutMode = useTabLayout().mode
  const revealed = useHeaderReveal(headerMode === 'hidden')
  useWorkspaceNavCommands(pass.workspaces, pass.activeId, pass.onSelect)
  return (
    <WorkspaceBar
      {...pass}
      {...menu}
      headerMode={headerMode}
      revealed={revealed}
      liveActiveNodes={liveNodes}
      onRenameWorkspace={onRenameWorkspace}
      onSetWorkspaceColor={onSetWorkspaceColor}
      onOpenPalette={() => omni.open('all')}
      layoutMode={layoutMode}
      titleActions={pass.workspaces.length > 0 ? <SecondarySideBarToggle /> : undefined}
    />
  )
}
