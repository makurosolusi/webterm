// App's inputs to the File / View / Help model, built once and handed to BOTH doors (the header's menu bar
// in Full, the rail's menu button in Compact/Hidden), so the two cannot be wired differently.
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'
import { toggleLayoutMode } from './tabLayout.commands'
import type { WorkspaceMenuProps } from './useWorkspaceMenus'

export interface ChromeMenuInputs {
  workspaces: Workspace[]
  activeId: string | null
  liveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  onNewProject: (path?: string) => void
  onDeleteWorkspace: (id: string) => Promise<unknown>
  onAddFiles: () => void
  setShowSettings: (open: boolean) => void
  setShowHelp: (open: boolean) => void
  openAccount: () => void
  onLogout?: () => void
  signedIn: boolean
}

/** Map App's state and handlers to the menu model's props. */
export function chromeMenuProps(i: ChromeMenuInputs): WorkspaceMenuProps {
  return {
    workspaces: i.workspaces, activeId: i.activeId, liveActiveNodes: i.liveNodes, statuses: i.statuses,
    onNewWorkspace: i.onNewProject, onDeleteWorkspace: (id) => void i.onDeleteWorkspace(id), onNewFiles: i.onAddFiles,
    onOpenSettings: () => i.setShowSettings(true), onOpenHelp: () => i.setShowHelp(true),
    onOpenAccount: i.openAccount, onLogout: i.onLogout, showLogout: i.signedIn, onToggleLayout: toggleLayoutMode,
  }
}
