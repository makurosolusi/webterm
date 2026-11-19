// The File / View / Help model as a hook: the ONE place both doors (the Full menu bar in the header and the
// rail's menu button in Compact/Hidden) get their menus from, so the two can never list different rows.
import { useMemo } from 'react'
import { useCommandShortcut } from '@/components/ui/icon-button'
import type { VscodeMenu } from '@/components/vscode/vscodeMenuBar'
import { buildSessionList } from './sessionList'
import { TOGGLE_HEADER_ID } from './headerMode.commands'
import { setHeaderMode, useHeaderMode } from './headerMode.store'
import { RAIL_LABELS_ID } from './workspaceNav.commands'
import { toggleRailLabels, useRailLabels } from './railLabels.store'
import { useWorkspaceTabActions } from './useWorkspaceTabActions'
import { buildWorkspaceMenus } from './workspaceBar.menus'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

/** What the menu model reads: the workspaces (for the active one's rows) and the handlers behind the rows. */
export interface WorkspaceMenuProps {
  workspaces: Workspace[]
  activeId: string | null
  /** Live nodes of the active workspace (session count for Delete's confirm). */
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  /** No path: pick an existing folder. A path (cloned / new project): open it as a workspace. */
  onNewWorkspace: (path?: string) => void
  /** Already confirmed by the menu's own prompt: the caller deletes at once. */
  onDeleteWorkspace: (id: string) => void
  onNewFiles?: () => void
  onOpenSettings?: () => void
  /** Settings > Account, and Sign out (rendered only with `showLogout`). */
  onOpenAccount?: () => void
  onLogout?: () => void
  showLogout?: boolean
  onOpenHelp?: () => void
  onToggleLayout?: () => void
}

/** File / View / Help for the current state; the same handlers run whichever door opens them. */
export function useWorkspaceMenus(p: WorkspaceMenuProps): VscodeMenu[] {
  const layoutKey = useCommandShortcut('view.layout.toggle')
  const outputKey = useCommandShortcut('output.toggle')
  const headerKey = useCommandShortcut(TOGGLE_HEADER_ID)
  const labelsKey = useCommandShortcut(RAIL_LABELS_ID)
  const storedMode = useHeaderMode()
  const railLabels = useRailLabels()
  const a = useWorkspaceTabActions(p.workspaces, p.onDeleteWorkspace)
  // Same aggregation as the sessions side bar (empty filter = every row), so counts never disagree.
  const groups = useMemo(() => buildSessionList(p.workspaces, p.liveActiveNodes, p.activeId, p.statuses, ''), [p.workspaces, p.liveActiveNodes, p.activeId, p.statuses])
  const active = groups.find((g) => g.projectId === p.activeId) ?? null
  return buildWorkspaceMenus({
    active: active && { projectId: active.projectId, projectName: active.projectName, sessionCount: active.sessions.length },
    layoutKey, outputKey, onNewWorkspace: () => p.onNewWorkspace(), onRename: a.setEditingId, onDelete: a.deleteWorkspace,
    onNewFiles: p.onNewFiles, onOpenSettings: p.onOpenSettings, onOpenAccount: p.onOpenAccount, onLogout: p.onLogout, showLogout: p.showLogout,
    onOpenHelp: p.onOpenHelp, onToggleLayout: p.onToggleLayout,
    headerMode: storedMode, onSetHeaderMode: setHeaderMode, headerKey,
    railLabels, onToggleRailLabels: toggleRailLabels, railLabelsKey: labelsKey,
  })
}
