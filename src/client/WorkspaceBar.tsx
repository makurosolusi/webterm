// The app header: ONE 35px row of workspace tabs (there is no title bar). The menu, search and account live in the
// left rail (`Dock`, `AppMenuButton`, `AccountMenu`); this row is only the workspaces and what belongs to the board.
//
// `VscodeEditorTabBar` draws one tab per workspace — status dot as icon, name as label, overflow/fade/wheel/reveal
// owned by the primitive. Like VS Code / browser tabs: `+` (new workspace) sits right after the last tab; per-workspace
// actions live ON the tab (right-click / Shift+F10 menu, double-click inline rename); tabs reorder by drag or
// Alt+Shift+Left/Right and the order is saved server-side; at the right end: "All workspaces" (Chrome's "search tabs"),
// the active worktree's branch, the board layout switch and the side bar toggle. File > Rename/Delete still act on the
// active workspace.
//
// The row renders ALWAYS, also before any workspace exists (`App` renders `Welcome` below it): the `+` button is the way
// in. Without a rail yet (booting, or no workspace) the row also carries the menu button and the account button, so no
// control is ever unreachable. `headerMode="hidden"` turns the row into an overlay shown only while `revealed`.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { buildSessionList } from './sessionList'
import { IconButton } from '@/components/ui/icon-button'
import { codicon } from './dockCodicon'
import type { HeaderMode } from './headerMode.store'
import { useWorktreeStatuses, WorkspaceWorktreeBadge } from './WorkspaceWorktreeBadge'
import { resetWorkspaceTabUi } from './workspaceTabUi.store'
import { AccountMenu } from './AccountMenu'
import { AppMenuButton } from './AppMenuButton'
import { AllWorkspaces, ALL_WORKSPACES_LABEL } from './WorkspaceBar.all'
import { WorkspaceTabStrip } from './WorkspaceBar.tabs'
import { WorkspaceBarHosts } from './WorkspaceBar.hosts'
import { useWorkspaceMenus } from './useWorkspaceMenus'
import { useWorkspaceTabActions } from './useWorkspaceTabActions'
import { useWorkspaceReorder } from './workspaceTabs.reorder'
import type { ColorChange } from './api'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

export interface WorkspaceBarProps {
  /** Semua workspace; tab order follows the server's `position` (see `useWorkspaceReorder`). */
  workspaces: Workspace[]
  activeId: string | null
  /** Node canvas workspace aktif (live). `null` sebelum workspace pertama termuat. */
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  onSelect: (id: string) => void
  /** No path: pick an existing folder. A path (cloned / new project): open it as a workspace. */
  onNewWorkspace: (path?: string) => void
  /** Nama sudah dinormalkan (trim, tidak pernah kosong). A returned promise shows the tab editor busy. */
  onRenameWorkspace: (id: string, name: string) => void | Promise<unknown>
  /** Tab menu > Color…: change a workspace's identity color (the menu row is absent without it). */
  onSetWorkspaceColor?: (id: string, change: ColorChange) => void | Promise<unknown>
  /** Sudah dikonfirmasi pengguna di sini — pemanggil langsung menghapus. */
  onDeleteWorkspace: (id: string) => void
  /** Persist the full tab order (ids left to right). Absent = tabs cannot be reordered. */
  onReorder?: (ids: string[]) => Promise<void>
  /** Sign out (POST /auth/logout) then reload to SignInScreen. Rendered only when `showLogout`. */
  onLogout?: () => void
  /** This browser holds a UI session (the `wt_ui` cookie), so there is something to sign out of. */
  showLogout?: boolean
  /** Settings › Account: "Account settings" in the account menu (absent: no account system). */
  onOpenAccount?: () => void
  /** File > Settings…: membuka Settings. Opsional supaya pemakaian lama tetap valid. */
  onOpenSettings?: () => void
  /** Help > Keyboard Shortcuts Reference: membuka overlay Help. */
  onOpenHelp?: () => void
  /** File > New Files Node: adds a Files node to the active board. */
  onNewFiles?: () => void
  /** Current board layout; with `onToggleLayout` it adds the canvas/tabs switch (button + View menu). */
  layoutMode?: 'canvas' | 'tabs'
  onToggleLayout?: () => void
  /** Layout controls at the right end of the row (Toggle Secondary Side Bar). */
  titleActions?: ReactNode
  /**
   * Effective header mode (`effectiveHeaderMode`): `tabs` = the row in the grid; `hidden` = the row as an overlay that
   * shows only while `revealed` (its layout switch is a rail button then). Default tabs.
   */
  headerMode?: HeaderMode
  /** Hidden only: the overlay is currently revealed (`useHeaderReveal`). */
  revealed?: boolean
  /** The rail is on screen and carries the menu and the account button; absent/false = this row carries them. */
  railChrome?: boolean
}

export default function WorkspaceBar({
  workspaces,
  activeId,
  liveActiveNodes,
  statuses,
  onSelect,
  onNewWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onSetWorkspaceColor,
  onReorder,
  onLogout,
  showLogout,
  onOpenAccount,
  onOpenSettings,
  onOpenHelp,
  onNewFiles,
  layoutMode,
  onToggleLayout,
  titleActions,
  headerMode = 'tabs',
  revealed = false,
  railChrome = false,
}: WorkspaceBarProps) {
  const reorder = useWorkspaceReorder(workspaces, onReorder)
  const { items } = reorder
  // Agregasi yang SAMA dengan sidebar sesi (filter kosong = semua baris). Memakai ulang
  // `buildSessionList` menjaga dot header dan badge sidebar tidak pernah bercerita beda.
  const groups = useMemo(
    () => buildSessionList(items, liveActiveNodes, activeId, statuses, ''),
    [items, liveActiveNodes, activeId, statuses],
  )
  const [allOpen, setAllOpen] = useState(false)
  const a = useWorkspaceTabActions(workspaces, onDeleteWorkspace)
  // The tab-surface state (menus, rename) never outlives the bar.
  useEffect(() => resetWorkspaceTabUi, [])
  const worktrees = useWorktreeStatuses(items)
  const activeGroup = groups.find((g) => g.projectId === activeId) ?? null

  const menus = useWorkspaceMenus({ workspaces, activeId, liveActiveNodes, statuses, onNewWorkspace, onDeleteWorkspace, onNewFiles, onOpenSettings, onOpenAccount, onLogout, showLogout, onOpenHelp, onToggleLayout })
  const hidden = headerMode === 'hidden'
  // Hidden has no row: its layout switch is in the rail's bottom group.
  const layoutToggle = !hidden && onToggleLayout && activeGroup ? <LayoutToggle layoutMode={layoutMode} onToggle={onToggleLayout} /> : null
  const showAll = items.length > 1
  return (
    <>
      <div className="app-tabs" data-header-region="" data-header-mode={headerMode} {...(hidden ? { 'data-revealed': revealed ? 'true' : 'false' } : {})}>
        {!railChrome && <div className="app-tabs__actions app-tabs__lead"><AppMenuButton menus={menus} variant="bar" /></div>}
        <WorkspaceTabStrip
          groups={groups}
          workspaces={items}
          worktrees={worktrees}
          activeId={activeId}
          editingId={a.editingId}
          onSelect={onSelect}
          onEdit={a.setEditingId}
          onRenameWorkspace={onRenameWorkspace}
          onTabMenu={(id, at) => a.setMenu({ id, ...at })}
          onAddMenu={a.setAddMenu}
          onMove={reorder.enabled ? reorder.move : undefined}
        />
        <div className="app-tabs__actions app-tabs__tail">
          {showAll && (
            <IconButton className="app-tabs__action" label={ALL_WORKSPACES_LABEL} tooltip="All workspaces: search and switch" data-slot="workspace-all" aria-haspopup="dialog" onClick={() => setAllOpen(true)}>
              <span className="codicon codicon-list-flat" aria-hidden />
            </IconButton>
          )}
          {activeId && <WorkspaceWorktreeBadge status={worktrees[activeId]} />}
          {layoutToggle}
          {titleActions}
          {!railChrome && showLogout && <AccountMenu onOpenAccount={onOpenAccount} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />}
        </div>
      </div>

      <AllWorkspaces open={allOpen} workspaces={items} worktrees={worktrees} activeId={activeId} onClose={() => setAllOpen(false)}
        onSelect={onSelect} onNew={() => a.setAddMenu(plusMenuAnchor())} />

      <WorkspaceBarHosts
        workspaces={workspaces}
        groups={groups}
        activeId={activeId}
        addMenu={a.addMenu}
        menu={a.menu}
        colorId={a.colorId}
        onCloseAddMenu={() => a.setAddMenu(null)}
        onCloseMenu={() => a.setMenu(null)}
        onCloseColor={() => a.setColorId(null)}
        onColor={a.setColorId}
        onRename={a.setEditingId}
        onDelete={a.deleteWorkspace}
        onSelect={onSelect}
        onNewWorkspace={onNewWorkspace}
        onSetWorkspaceColor={onSetWorkspaceColor}
      />
    </>
  )
}

/** Gap between the `+` button and the menu opened below it. */
const PLUS_MENU_GAP_PX = 4

/** Where the `+` menu opens when it is reached from "All workspaces": under the row's own `+` button. */
function plusMenuAnchor(): { x: number; y: number } {
  const r = document.querySelector('.app-tabs [aria-label="New workspace"]')?.getBoundingClientRect()
  return r ? { x: r.left, y: r.bottom + PLUS_MENU_GAP_PX } : { x: 0, y: 0 }
}

/** One layout switch per board (VS Code keeps layout controls in the title bar, not per editor group); `rail` = Hidden mode's door. */
export function LayoutToggle({ layoutMode, onToggle, variant = 'bar' }: { layoutMode?: 'canvas' | 'tabs'; onToggle: () => void; variant?: 'bar' | 'rail' }) {
  const label = layoutMode === 'tabs' ? 'Switch to canvas layout' : 'Switch to tab layout'
  if (variant === 'rail') {
    return (
      <IconButton className="vscode-activity-bar__item dock-btn rounded-none" label="Toggle tab layout" tooltip={label} commandId="view.layout.toggle"
        side="right" aria-pressed={layoutMode === 'tabs'} onClick={onToggle}>
        <span className="vscode-activity-bar__icon" aria-hidden>{codicon('editor-layout')}</span>
      </IconButton>
    )
  }
  return (
    <IconButton className="app-tabs__action" label="Toggle tab layout" tooltip={label} commandId="view.layout.toggle" aria-pressed={layoutMode === 'tabs'} onClick={onToggle}>
      <span className="codicon codicon-editor-layout" aria-hidden />
    </IconButton>
  )
}
