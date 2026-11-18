// Title bar + editor tab strip aplikasi, mengikuti chrome VS Code.
//
// Baris 1 (35px): brand, `VscodeMenuBar` (File / Help — urutan & label mengikuti VS Code; menu
// yang tak punya padanan di webterm tidak dibuat), identitas workspace aktif di tengah, dan aksi
// kanan (menu akun).
//
// Baris 2 (35px): `VscodeEditorTabBar` memuat satu tab per workspace — status dot sebagai ikon,
// nama sebagai label, overflow/fade/wheel/reveal milik primitif. Like VS Code / browser tabs:
// `+` (new workspace) sits right after the last tab (sticky at the visible edge on overflow);
// per-workspace actions live ON the tab (right-click / Shift+F10 menu, double-click inline
// rename); the board-scoped layout toggle sits at the far right, where VS Code puts editor-group
// actions. File > Rename/Delete still act on the active workspace.
//
// Kedua baris dirender SELALU, juga saat belum ada workspace (`App` merender `Welcome` di
// bawahnya): tombol `+` jalan masuk yang sama. Tanpa workspace, layout toggle DISEMBUNYIKAN.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { buildSessionList } from './sessionList'
import { useCommandShortcut } from '@/components/ui/icon-button'
import { VscodeMenuBar } from '@/components/vscode/vscodeMenuBar'
import { AppMenuButton } from './AppMenuButton'
import { TOGGLE_HEADER_ID } from './headerMode.commands'
import { setHeaderMode, useHeaderMode, type HeaderMode } from './headerMode.store'
import { useWorktreeStatuses } from './WorkspaceWorktreeBadge'
import { CommandPill, LayoutToggle } from './WorkspaceBar.pill'
import { resetWorkspaceTabUi } from './workspaceTabUi.store'
import { AccountMenu } from './AccountMenu'
import { workspaceColorVar } from '../shared/workspaceColor'
import { CompactTail, WorkspaceTabStrip } from './WorkspaceBar.tabs'
import { WorkspaceBarHosts } from './WorkspaceBar.hosts'
import { buildWorkspaceMenus } from './workspaceBar.menus'
import { useWorkspaceTabActions } from './useWorkspaceTabActions'
import type { ColorChange } from './api'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'


export interface WorkspaceBarProps {
  /** Semua workspace, urutan tab mengikuti urutan array ini. */
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
  /** Sign out (POST /auth/logout) then reload to SignInScreen. Rendered only when `showLogout`. */
  onLogout?: () => void
  /** This browser holds a UI session (the `wt_ui` cookie), so there is something to sign out of. */
  showLogout?: boolean
  /** Settings › Account: "Account settings" in the title-bar account menu (absent: no account system). */
  onOpenAccount?: () => void
  /** File > Settings…: membuka Settings. Opsional supaya pemakaian lama tetap valid. */
  onOpenSettings?: () => void
  /** Help > Keyboard Shortcuts Reference: membuka overlay Help. */
  onOpenHelp?: () => void
  /** File > New Files Node: adds a Files node to the active board. */
  onNewFiles?: () => void
  /** Command center click: opens the omnibox (`workbench.omnibox`, Mod+K). */
  onOpenPalette?: () => void
  /** Current board layout; with `onToggleLayout` it adds the canvas/tabs switch (button + View menu). */
  layoutMode?: 'canvas' | 'tabs'
  onToggleLayout?: () => void
  /** Layout controls at the right end of the title bar (Toggle Secondary Side Bar). */
  titleActions?: ReactNode
  /**
   * Effective header mode (`effectiveHeaderMode`): Full = title bar + tab row; Compact = the tab row
   * alone, with the menu, search and account joined into it; Hidden = both rows as an overlay that
   * shows only while `revealed`. Default Full, so existing callers are unchanged.
   */
  headerMode?: HeaderMode
  /** Hidden only: the overlay is currently revealed (`useHeaderReveal`). */
  revealed?: boolean
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
  onLogout,
  showLogout,
  onOpenAccount,
  onOpenSettings,
  onOpenHelp,
  onNewFiles,
  onOpenPalette,
  layoutMode,
  onToggleLayout,
  titleActions,
  headerMode = 'full',
  revealed = false,
}: WorkspaceBarProps) {
  const layoutKey = useCommandShortcut('view.layout.toggle')
  const outputKey = useCommandShortcut('output.toggle')
  const headerKey = useCommandShortcut(TOGGLE_HEADER_ID)
  const storedMode = useHeaderMode()
  // Agregasi yang SAMA dengan sidebar sesi (filter kosong = semua baris). Memakai ulang
  // `buildSessionList` menjaga dot header dan badge sidebar tidak pernah bercerita beda.
  const groups = useMemo(
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, ''),
    [workspaces, liveActiveNodes, activeId, statuses],
  )
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const a = useWorkspaceTabActions(workspaces, onDeleteWorkspace)
  // The tab-surface state is shared with the rail tiles; it never outlives the bar.
  useEffect(() => resetWorkspaceTabUi, [])
  const worktrees = useWorktreeStatuses(workspaces)
  const activeGroup = groups.find((g) => g.projectId === activeId) ?? null
  const accentOf = (id: string): string => workspaceColorVar(workspaces.find((x) => x.id === id)?.color, workspaces.find((x) => x.id === id)?.colorShade)

  const menus = buildWorkspaceMenus({
    active: activeGroup && { projectId: activeGroup.projectId, projectName: activeGroup.projectName, sessionCount: activeGroup.sessions.length },
    layoutKey, outputKey, onNewWorkspace: () => onNewWorkspace(), onRename: a.setEditingId, onDelete: a.deleteWorkspace,
    onNewFiles, onOpenSettings, onOpenAccount, onLogout, showLogout, onOpenHelp, onToggleLayout,
    headerMode: storedMode, onSetHeaderMode: setHeaderMode, headerKey,
  })
  const hidden = headerMode === 'hidden'
  const compact = headerMode === 'compact'
  const overlayState = hidden ? { 'data-revealed': revealed ? 'true' : 'false' } : {}
  const accent = activeId ? accentOf(activeId) : undefined
  const pill = <CommandPill onOpenPalette={onOpenPalette} accent={accent} name={activeGroup?.projectName} worktree={activeId ? worktrees[activeId] : undefined} />
  const layoutToggle = onToggleLayout && activeGroup ? <LayoutToggle layoutMode={layoutMode} onToggle={onToggleLayout} /> : null
  return (
    <>
      {!compact && (
      <header className="app-titlebar" data-header-region="" {...overlayState}>
        <div className="brand">
          <span className="brand__mark codicon codicon-terminal" aria-hidden />
          <span className="brand__name">webterm</span>
        </div>

        <VscodeMenuBar menus={menus} openId={menuOpen} onOpenChange={setMenuOpen} />

        {/* Command center: identitas workspace aktif. */}
        <div className="app-titlebar__center">{pill}</div>

        <div className="app-titlebar__actions">
          {/* Hidden has no tab row, so its layout switch rides in the revealed title bar. */}
          {hidden && layoutToggle}
          {titleActions}
          {showLogout && <AccountMenu onOpenAccount={onOpenAccount} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />}
        </div>
      </header>
      )}

      {/* Workspaces are strip tabs only in Full. Compact/Hidden show them as rail tiles (WorkspaceRail),
          so Compact's single row is menu, command pill and actions, and Hidden has no tab row at all. */}
      {!hidden && (
      <div className="app-tabs" data-header-region="">
        {compact && <AppMenuButton menus={menus} openId={menuOpen} onOpenChange={setMenuOpen} />}
        {compact ? (
          <div className="app-titlebar__center">{pill}</div>
        ) : (
          <WorkspaceTabStrip
            groups={groups}
            workspaces={workspaces}
            worktrees={worktrees}
            activeId={activeId}
            editingId={a.editingId}
            onSelect={onSelect}
            onEdit={a.setEditingId}
            onRenameWorkspace={onRenameWorkspace}
            onTabMenu={(id, at) => a.setMenu({ id, ...at })}
            onAddMenu={a.setAddMenu}
          />
        )}
        {layoutToggle && <div className="app-tabs__actions">{layoutToggle}</div>}
        {compact && <CompactTail {...{ titleActions, showLogout, onOpenAccount, onOpenSettings, onOpenHelp }} />}
      </div>
      )}

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
