// Title bar + editor tab strip aplikasi, mengikuti chrome VS Code.
//
// Baris 1 (35px): brand, `VscodeMenuBar` (File / Help — urutan & label mengikuti VS Code; menu
// yang tak punya padanan di webterm tidak dibuat), identitas workspace aktif di tengah, dan aksi
// kanan (menu akun). Hanya mode Full: di Compact/Hidden menu dan akun pindah ke rail (`RailChrome`).
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
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { buildSessionList } from './sessionList'
import { IconButton, IconTooltip, useCommandShortcut } from '@/components/ui/icon-button'
import { VscodeMenuBar } from '@/components/vscode/vscodeMenuBar'
import { codicon } from './dockCodicon'
import type { HeaderMode } from './headerMode.store'
import { useWorktreeStatuses, WorkspaceWorktreeBadge } from './WorkspaceWorktreeBadge'
import type { WorktreeStatus } from './workspaceWorktree.api'
import { resetWorkspaceTabUi } from './workspaceTabUi.store'
import { AccountMenu } from './AccountMenu'
import { workspaceColorVar } from '../shared/workspaceColor'
import { WorkspaceTabStrip } from './WorkspaceBar.tabs'
import { WorkspaceBarHosts } from './WorkspaceBar.hosts'
import { useWorkspaceMenus } from './useWorkspaceMenus'
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
   * Effective header mode (`effectiveHeaderMode`): Full = title bar + tab row; Compact = one row (command
   * pill, layout switch, side bar toggle); Hidden = the title bar (pill, side bar toggle) as an overlay that
   * shows only while `revealed`. In Compact/Hidden the menu, account and (Hidden) layout switch are in the
   * rail. Default Full, so existing callers are unchanged.
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

  const menus = useWorkspaceMenus({ workspaces, activeId, liveActiveNodes, statuses, onNewWorkspace, onDeleteWorkspace, onNewFiles, onOpenSettings, onOpenAccount, onLogout, showLogout, onOpenHelp, onToggleLayout })
  const full = headerMode === 'full'
  const hidden = headerMode === 'hidden'
  const compact = headerMode === 'compact'
  const overlayState = hidden ? { 'data-revealed': revealed ? 'true' : 'false' } : {}
  const accent = activeId ? accentOf(activeId) : undefined
  const pill = <CommandPill onOpenPalette={onOpenPalette} accent={accent} name={activeGroup?.projectName} worktree={activeId ? worktrees[activeId] : undefined} />
  // Hidden has no tab row: its layout switch is in the rail's bottom group.
  const layoutToggle = !hidden && onToggleLayout && activeGroup ? <LayoutToggle layoutMode={layoutMode} onToggle={onToggleLayout} /> : null
  return (
    <>
      {!compact && (
      <header className="app-titlebar" data-header-region="" {...overlayState}>
        {/* Menu bar, brand and account are Full only: Compact/Hidden carry them in the rail (nothing twice). */}
        {full && (
          <>
            <div className="brand">
              <span className="brand__mark codicon codicon-terminal" aria-hidden />
              <span className="brand__name">webterm</span>
            </div>
            <VscodeMenuBar menus={menus} openId={menuOpen} onOpenChange={setMenuOpen} />
          </>
        )}

        {/* Command center: identitas workspace aktif. */}
        <div className="app-titlebar__center">{pill}</div>

        <div className="app-titlebar__actions">
          {titleActions}
          {full && showLogout && <AccountMenu onOpenAccount={onOpenAccount} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />}
        </div>
      </header>
      )}

      {/* Workspaces are strip tabs only in Full. Compact/Hidden show them as rail tiles (WorkspaceRail),
          so Compact's single row is command pill and actions, and Hidden has no tab row at all. */}
      {!hidden && (
      <div className="app-tabs" data-header-region="">
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
        {compact && titleActions && <div className="app-tabs__actions app-titlebar__actions app-tabs__tail">{titleActions}</div>}
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

// Two small controls shared by the header's modes and the rail: the command center pill (active workspace
// identity + search) and the board layout toggle (tab row in Full, Compact row, or the rail's bottom group in Hidden
// as `variant="rail"`). One implementation, so the modes cannot drift apart.
export interface CommandPillProps {
  /** Opens the omnibox; absent = a plain, non-interactive name. */
  onOpenPalette?: () => void
  /** CSS color of the active workspace (`var(--ws-*)`); absent = no chip. */
  accent?: string
  name?: string
  worktree?: WorktreeStatus
}

/** VS Code command center: opens Go to Anything, shows the active workspace and the chord. */
export function CommandPill({ onOpenPalette, accent, name, worktree }: CommandPillProps) {
  const paletteKey = useCommandShortcut('workbench.omnibox')
  if (!onOpenPalette) {
    return (
      <span className="app-titlebar__name">
        {name ?? ''}
        <WorkspaceWorktreeBadge status={worktree} />
      </span>
    )
  }
  return (
    <IconTooltip label="Go to anything: nodes, files, URLs, agents, commands" commandId="workbench.omnibox">
      <button type="button" className="app-titlebar__name" aria-label="Search" onClick={onOpenPalette}>
        <span className="codicon codicon-search" aria-hidden />
        {accent && <span className="ws-chip" aria-hidden style={{ '--ws-chip': accent } as CSSProperties} />}
        <span className="app-titlebar__label">{name ?? 'Search'}</span>
        <WorkspaceWorktreeBadge status={worktree} />
        {paletteKey && <span className="kbd">{paletteKey}</span>}
      </button>
    </IconTooltip>
  )
}

/** One layout switch per board (VS Code keeps layout controls in the title bar, not per editor group). */
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
    <IconTooltip label={label} commandId="view.layout.toggle">
      <button type="button" className="app-tabs__action" aria-label="Toggle tab layout" aria-pressed={layoutMode === 'tabs'} onClick={onToggle}>
        <span className="codicon codicon-editor-layout" aria-hidden />
      </button>
    </IconTooltip>
  )
}
