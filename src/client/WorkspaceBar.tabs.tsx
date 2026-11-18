// Workspace tab strip: one `VscodeEditorTab` per workspace plus the trailing `+` button.
// Worktree state on the tab: VS Code's dirty dot plus branch in the tooltip; the full badge sits
// next to the active workspace's name in the title bar (the tab label slot is a plain string).
import type { ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { AccountMenu } from './AccountMenu'
import { VscodeEditorTabBar } from '@/components/vscode/vscodeEditorTabBar'
import type { VscodeEditorTab } from '@/components/vscode/vscodeEditorTabBar'
import type { SessionGroup } from './sessionList'
import { workspaceTabFields } from './WorkspaceTabDot'
import { WorkspaceTabRename } from './WorkspaceTabRename'
import { worktreeSummary } from './WorkspaceWorktreeBadge'
import type { WorktreeStatus } from './workspaceWorktree.api'
import type { PointAt } from './useWorkspaceTabActions'
import type { Workspace } from '../shared/workspace'

/** Jarak menu dari tepi bawah tombol `+` (`r.bottom + 4`). */
const MENU_GAP = 4

export interface WorkspaceTabStripProps {
  groups: SessionGroup[]
  workspaces: Workspace[]
  worktrees: Record<string, WorktreeStatus | undefined>
  activeId: string | null
  editingId: string | null
  onSelect: (id: string) => void
  onEdit: (id: string | null) => void
  onRenameWorkspace: (id: string, name: string) => void | Promise<unknown>
  onTabMenu: (id: string, at: PointAt) => void
  onAddMenu: (at: PointAt) => void
}

export function WorkspaceTabStrip({ groups, workspaces, worktrees, activeId, editingId, onSelect, onEdit, onRenameWorkspace, onTabMenu, onAddMenu }: WorkspaceTabStripProps): ReactNode {
  const tabs: VscodeEditorTab[] = groups.map((g) => {
    const wt = worktrees[g.projectId]
    return {
      id: g.projectId,
      label: g.projectName,
      ...workspaceTabFields(g, workspaces.find((x) => x.id === g.projectId), wt?.managed ? worktreeSummary(wt) : undefined),
      dirty: wt?.managed === true && (wt.dirtyCount ?? 0) > 0,
      editor: editingId === g.projectId
        ? <WorkspaceTabRename initial={g.projectName} onCommit={(name) => onRenameWorkspace(g.projectId, name)} onClose={() => onEdit(null)} />
        : undefined,
    }
  })
  return (
    <VscodeEditorTabBar
      tabs={tabs}
      activeId={activeId}
      onActivate={onSelect}
      onDoubleClick={onEdit}
      onContextMenu={onTabMenu}
      ariaLabel="Workspaces"
      trailing={
        <IconTooltip label="New workspace: open a folder, clone a repository or create a project">
          <button
            type="button"
            className="app-tabs__action"
            aria-label="New workspace"
            onClick={(e) => {
              // Three ways in, as welcome cards: open a folder, clone, or start a new project.
              const r = e.currentTarget.getBoundingClientRect()
              onAddMenu({ x: r.left, y: r.bottom + MENU_GAP })
            }}
          >
            <span className="codicon codicon-add" aria-hidden />
          </button>
        </IconTooltip>
      }
    />
  )
}

// Compact header mode: the title bar row is gone, so the title-bar actions (secondary side bar toggle)
// and the account menu join the single row, after the command pill. Same handlers as the Full title bar.
export interface CompactTailProps {
  titleActions?: ReactNode
  showLogout?: boolean
  onOpenAccount?: () => void
  onOpenSettings?: () => void
  onOpenHelp?: () => void
}

/** Right end of the Compact row. */
export function CompactTail({ titleActions, showLogout, onOpenAccount, onOpenSettings, onOpenHelp }: CompactTailProps) {
  return (
    <div className="app-tabs__actions app-titlebar__actions app-tabs__tail">
      {titleActions}
      {showLogout && <AccountMenu onOpenAccount={onOpenAccount} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />}
    </div>
  )
}
