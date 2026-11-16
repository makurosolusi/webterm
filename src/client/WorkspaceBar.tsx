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
import { useMemo, useState, type ReactNode } from 'react'
import NodeContextMenu from './NodeContextMenu'
import { buildSessionList } from './sessionList'
import { workspaceTabDot, workspaceTabTitle } from './workspaceTabs'
import { deleteWorkspaceMessage } from './workspaceMenu'
import { WorkspaceTabRename } from './WorkspaceTabRename'
import { IconTooltip, useCommandShortcut } from '@/components/ui/icon-button'
import { VscodeEditorTabBar } from '@/components/vscode/vscodeEditorTabBar'
import type { VscodeEditorTab } from '@/components/vscode/vscodeEditorTabBar'
import { VscodeMenuBar } from '@/components/vscode/vscodeMenuBar'
import type { VscodeMenu, VscodeMenuEntry } from '@/components/vscode/vscodeMenuBar'
import { clearOutput, toggleOutput } from './output/outputCommands'
import { offerRemoveWorktree } from './workspaceWorktree.api'
import { useWorktreeStatuses, worktreeSummary, WorkspaceWorktreeBadge } from './WorkspaceWorktreeBadge'
import WorkspaceCreateHost, { openWorkspaceCreate } from './workspaceCreate/WorkspaceCreateHost'
import { openWorkspaceCanvasBackground } from './canvasBackground.open'
import { setWorkspaceMuted, useNotifyPrefs } from './osNotify.prefs'
import { openSetup } from './setup/setup.open'
import { AccountMenu } from './AccountMenu'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

/** Jarak menu dari tepi bawah tombol `+` (`r.bottom + 4`). */
const MENU_GAP = 4

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
}: WorkspaceBarProps) {
  const paletteKey = useCommandShortcut('workbench.omnibox')
  const layoutKey = useCommandShortcut('view.layout.toggle')
  const outputKey = useCommandShortcut('output.toggle')
  // Agregasi yang SAMA dengan sidebar sesi (filter kosong = semua baris). Memakai ulang
  // `buildSessionList` menjaga dot header dan badge sidebar tidak pernah bercerita beda.
  const groups = useMemo(
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, ''),
    [workspaces, liveActiveNodes, activeId, statuses],
  )

  /** Tab context menu: which workspace it acts on (not necessarily the active one) and where. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const mutedIds = useNotifyPrefs().muted
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  const worktrees = useWorktreeStatuses(workspaces)
  const activeGroup = groups.find((g) => g.projectId === activeId) ?? null

  const menuGroup = menu ? groups.find((g) => g.projectId === menu.id) ?? null : null

  const deleteWorkspace = (projectId: string, projectName: string, sessions: number): void => {
    // Hapus TIDAK bisa dibatalkan (row workspace + seluruh board tersimpannya hilang), jadi ia
    // wajib lewat satu langkah konfirmasi. `confirm()` native adalah modal yang tidak bisa
    // terklik sambil lalu; browser yang menekan dialognya memulangkan `false` → tidak menghapus.
    if (!window.confirm(deleteWorkspaceMessage(projectName, sessions))) return
    // A worktree workspace then offers to remove its checkout too (second confirm, branch kept). A
    // failed removal is shown and the workspace stays, so its dirty work is never orphaned silently.
    const cwd = workspaces.find((w) => w.id === projectId)?.cwd
    offerRemoveWorktree(cwd).then(
      () => onDeleteWorkspace(projectId),
      (err: unknown) => window.alert(`Workspace not deleted: ${err instanceof Error ? err.message : String(err)}`),
    )
  }

  // File: New → Rename/Delete (workspace aktif) → Settings → Logout, seperti File di VS Code
  // (aksi dokumen, lalu Preferences, lalu keluar). Delete tidak diberi warna bahaya: VS Code tak
  // mewarnai item menu, dan konfirmasi `window.confirm` sudah menjaga aksinya.
  const fileItems: VscodeMenuEntry[] = [
    { id: 'new-workspace', label: 'New Workspace', onSelect: () => onNewWorkspace() },
    { id: 'clone-repository', label: 'Clone Repository…', onSelect: () => openWorkspaceCreate('clone') },
    { id: 'new-project', label: 'New Project…', onSelect: () => openWorkspaceCreate('project') },
  ]
  if (activeGroup && onNewFiles) fileItems.push({ type: 'separator' }, { id: 'new-files', label: 'New Files Node', onSelect: onNewFiles })
  if (activeGroup) {
    fileItems.push(
      { type: 'separator' },
      {
        id: 'rename-workspace',
        label: 'Rename Workspace…',
        onSelect: () => setEditingId(activeGroup.projectId),
      },
      {
        id: 'delete-workspace',
        label: 'Delete Workspace',
        onSelect: () => deleteWorkspace(activeGroup.projectId, activeGroup.projectName, activeGroup.sessions.length),
      },
    )
  }
  if (onOpenSettings) fileItems.push({ type: 'separator' }, { id: 'settings', label: 'Settings…', onSelect: onOpenSettings })
  if (showLogout && onOpenAccount) fileItems.push({ type: 'separator' }, { id: 'account', label: 'Account…', onSelect: onOpenAccount })
  if (showLogout && onLogout) fileItems.push(...(onOpenAccount ? [] : [{ type: 'separator' } as const]), { id: 'logout', label: 'Sign out', onSelect: onLogout })

  const viewItems: VscodeMenuEntry[] = [
    ...(onToggleLayout ? [{ id: 'toggle-layout', label: 'Toggle Tab Layout', keybinding: layoutKey ?? undefined, disabled: !activeGroup, onSelect: onToggleLayout }] : []),
    { id: 'output', label: 'Output', keybinding: outputKey, onSelect: toggleOutput },
    { id: 'clear-output', label: 'Clear Output', onSelect: () => void clearOutput() },
  ]
  const menus: VscodeMenu[] = [
    { id: 'file', label: 'File', items: fileItems },
    { id: 'view', label: 'View', items: viewItems },
  ]
  if (onOpenHelp) {
    menus.push({
      id: 'help',
      label: 'Help',
      items: [{ id: 'shortcuts', label: 'Keyboard Shortcuts Reference', onSelect: onOpenHelp }, { id: 'setup', label: 'Set up webterm…', onSelect: () => openSetup() }],
    })
  }

  // Worktree state on the tab: VS Code's dirty dot plus branch in the tooltip; the full badge sits
  // next to the active workspace's name in the title bar (the tab label slot is a plain string).
  const tabs: VscodeEditorTab[] = groups.map((g) => {
    const wt = worktrees[g.projectId]
    return {
      id: g.projectId,
      label: g.projectName,
      tooltip: wt?.managed ? `${workspaceTabTitle(g)}\n${worktreeSummary(wt)}` : workspaceTabTitle(g),
      icon: <span className={`tab__dot tab__dot--${workspaceTabDot(g)}`} aria-hidden />,
      dirty: wt?.managed === true && (wt.dirtyCount ?? 0) > 0,
      editor: editingId === g.projectId
        ? <WorkspaceTabRename initial={g.projectName} onCommit={(name) => onRenameWorkspace(g.projectId, name)} onClose={() => setEditingId(null)} />
        : undefined,
    }
  })

  return (
    <>
      <header className="app-titlebar">
        <div className="brand">
          <span className="brand__mark codicon codicon-terminal" aria-hidden />
          <span className="brand__name">webterm</span>
        </div>

        <VscodeMenuBar menus={menus} openId={menuOpen} onOpenChange={setMenuOpen} />

        {/* Command center: identitas workspace aktif. */}
        <div className="app-titlebar__center">
          {onOpenPalette ? (
            // VS Code command center: the pill opens Go to Anything and shows its chord.
            <IconTooltip label="Go to anything: nodes, files, URLs, agents, commands" commandId="workbench.omnibox">
              <button type="button" className="app-titlebar__name" aria-label="Search" onClick={onOpenPalette}>
                <span className="codicon codicon-search" aria-hidden />
                <span className="app-titlebar__label">{activeGroup?.projectName ?? 'Search'}</span>
                <WorkspaceWorktreeBadge status={activeId ? worktrees[activeId] : undefined} />
                {paletteKey && <span className="kbd">{paletteKey}</span>}
              </button>
            </IconTooltip>
          ) : (
            <span className="app-titlebar__name">
              {activeGroup?.projectName ?? ''}
              <WorkspaceWorktreeBadge status={activeId ? worktrees[activeId] : undefined} />
            </span>
          )}
        </div>

        <div className="app-titlebar__actions">
          {titleActions}
          {showLogout && <AccountMenu onOpenAccount={onOpenAccount} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />}
        </div>
      </header>

      <div className="app-tabs">
        <VscodeEditorTabBar
          tabs={tabs}
          activeId={activeId}
          onActivate={onSelect}
          onDoubleClick={setEditingId}
          onContextMenu={(id, at) => setMenu({ id, ...at })}
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
                  setAddMenu({ x: r.left, y: r.bottom + MENU_GAP })
                }}
              >
                <span className="codicon codicon-add" aria-hidden />
              </button>
            </IconTooltip>
          }
        />
        {onToggleLayout && activeGroup && (
          <div className="app-tabs__actions">
            <IconTooltip label={layoutMode === 'tabs' ? 'Switch to canvas layout' : 'Switch to tab layout'} commandId="view.layout.toggle">
              <button
                type="button"
                className="app-tabs__action"
                aria-label="Toggle tab layout"
                aria-pressed={layoutMode === 'tabs'}
                onClick={onToggleLayout}
              >
                {/* One layout switch per board (VS Code keeps layout controls in the title bar, not per editor group). */}
                <span className="codicon codicon-editor-layout" aria-hidden />
              </button>
            </IconTooltip>
          </div>
        )}
      </div>

      {addMenu && (
        <NodeContextMenu
          x={addMenu.x}
          y={addMenu.y}
          rows={[
            { label: 'Open Folder…', onClick: () => onNewWorkspace() },
            { label: 'Clone Repository…', onClick: () => openWorkspaceCreate('clone') },
            { label: 'New Project…', onClick: () => openWorkspaceCreate('project') },
          ]}
          onClose={() => setAddMenu(null)}
        />
      )}
      <WorkspaceCreateHost onOpenFolder={() => onNewWorkspace()} onCreated={(path) => onNewWorkspace(path)} onOpenWorkspace={onSelect} />

      {menu && menuGroup && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          rows={[
            { label: 'Rename', onClick: () => setEditingId(menuGroup.projectId) },
            // The background editor (Settings › Appearance) works on the active board, so open this one first.
            { label: 'Canvas Background…', onClick: () => { if (menuGroup.projectId !== activeId) onSelect(menuGroup.projectId); openWorkspaceCanvasBackground() } },
            // Per-workspace mute lives here, next to the workspace (Settings › Notifications holds the global switches).
            mutedIds.includes(menuGroup.projectId)
              ? { label: 'Unmute Notifications', onClick: () => setWorkspaceMuted(menuGroup.projectId, false) }
              : { label: 'Mute Notifications', onClick: () => setWorkspaceMuted(menuGroup.projectId, true) },
            { type: 'separator' },
            {
              label: 'Delete',
              danger: true,
              onClick: () => deleteWorkspace(menuGroup.projectId, menuGroup.projectName, menuGroup.sessions.length),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}
