// Title bar + editor tab strip aplikasi, mengikuti chrome VS Code.
//
// Baris 1 (35px): brand, `VscodeMenuBar` (File / Help — urutan & label mengikuti VS Code; menu
// yang tak punya padanan di webterm tidak dibuat), identitas workspace aktif di tengah, dan aksi
// kanan (logout). Rename workspace memakai command center di tengah itu: input
// muncul di tempat yang sudah terlihat, bukan di dalam tab yang bisa tergulung keluar layar.
//
// Baris 2 (35px): `VscodeEditorTabBar` memuat satu tab per workspace — status dot sebagai ikon,
// nama sebagai label, overflow/fade/wheel/reveal milik primitif. Di ujung kanan deretan duduk dua
// aksi baris: kebab menu workspace aktif (satu-satunya permukaan rename/hapus) dan `+` workspace
// baru. `+` sengaja SAUDARA strip, bukan anaknya, supaya 10+ workspace tidak mendorongnya keluar
// layar.
//
// Kedua baris dirender SELALU, juga saat belum ada workspace (`App` merender `Welcome` di
// bawahnya): tombol `+` adalah jalan masuk yang sama, dan chrome yang baru muncul setelah
// workspace pertama menggeser canvas tepat saat pengguna menekan tombol.
import { useMemo, useState } from 'react'
import NodeContextMenu from './NodeContextMenu'
import { buildSessionList } from './sessionList'
import { workspaceTabDot, workspaceTabTitle } from './workspaceTabs'
import { deleteWorkspaceMessage, normalizeWorkspaceName } from './workspaceMenu'
import { Input } from '@/components/ui/input'
import { IconTooltip, useCommandShortcut } from '@/components/ui/icon-button'
import { VscodeEditorTabBar } from '@/components/vscode/vscodeEditorTabBar'
import type { VscodeEditorTab } from '@/components/vscode/vscodeEditorTabBar'
import { VscodeMenuBar } from '@/components/vscode/vscodeMenuBar'
import type { VscodeMenu, VscodeMenuEntry } from '@/components/vscode/vscodeMenuBar'
import { clearOutput, toggleOutput } from './output/outputCommands'
import { outputShortcutLabel } from './output/outputChord'
import { isMacPlatform } from './terminalKeys'
import { offerRemoveWorktree } from './workspaceWorktree.api'
import { useWorktreeStatuses, worktreeSummary, WorkspaceWorktreeBadge } from './WorkspaceWorktreeBadge'
import WorkspaceCreateHost, { openWorkspaceCreate } from './workspaceCreate/WorkspaceCreateHost'
import { openWorkspaceCanvasBackground } from './CanvasBackgroundSection'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

/** Jarak menu dari tepi bawah tombol kebab-nya, seperti nodeterm (`openMenu`: `r.bottom + 4`). */
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
  /** Nama sudah dinormalkan (trim, tidak pernah kosong) sebelum sampai ke sini. */
  onRenameWorkspace: (id: string, name: string) => void
  /** Sudah dikonfirmasi pengguna di sini — pemanggil langsung menghapus. */
  onDeleteWorkspace: (id: string) => void
  /** Buang token lalu reload ke layar Login. Hanya dirender bila `showLogout`. */
  onLogout?: () => void
  /** Ada token tersimpan → tampilkan tombol logout. Loopback tanpa token: tak ada yang di-logout. */
  showLogout?: boolean
  /** File > Settings…: membuka Settings. Opsional supaya pemakaian lama tetap valid. */
  onOpenSettings?: () => void
  /** Help > Keyboard Shortcuts Reference: membuka overlay Help. */
  onOpenHelp?: () => void
  /** File > New Files Node: adds a Files node to the active board. */
  onNewFiles?: () => void
  /** Command center click: opens the omnibox (`workbench.omnibox`, Mod+K). */
  onOpenPalette?: () => void
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
  onOpenSettings,
  onOpenHelp,
  onNewFiles,
  onOpenPalette,
}: WorkspaceBarProps) {
  const paletteKey = useCommandShortcut('workbench.omnibox')
  // Agregasi yang SAMA dengan sidebar sesi (filter kosong = semua baris). Memakai ulang
  // `buildSessionList` menjaga dot header dan badge sidebar tidak pernah bercerita beda.
  const groups = useMemo(
    () => buildSessionList(workspaces, liveActiveNodes, activeId, statuses, ''),
    [workspaces, liveActiveNodes, activeId, statuses],
  )

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const worktrees = useWorktreeStatuses(workspaces)
  const activeGroup = groups.find((g) => g.projectId === activeId) ?? null

  const commitRename = (): void => {
    if (!editingId) return
    const name = normalizeWorkspaceName(draft)
    const before = workspaces.find((w) => w.id === editingId)?.name
    // Draft kosong/spasi, atau nama yang tidak berubah: tutup editor tanpa menulis apa-apa — PUT
    // workspace itu mahal (seluruh board ikut dikirim) dan rename yang sama tidak membawa apa pun.
    if (name && name !== before) onRenameWorkspace(editingId, name)
    setEditingId(null)
  }

  const startRename = (id: string, current: string): void => {
    setEditingId(id)
    setDraft(current)
  }

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
        onSelect: () => startRename(activeGroup.projectId, activeGroup.projectName),
      },
      {
        id: 'delete-workspace',
        label: 'Delete Workspace',
        onSelect: () => deleteWorkspace(activeGroup.projectId, activeGroup.projectName, activeGroup.sessions.length),
      },
    )
  }
  if (onOpenSettings) fileItems.push({ type: 'separator' }, { id: 'settings', label: 'Settings…', onSelect: onOpenSettings })
  if (showLogout && onLogout) fileItems.push({ type: 'separator' }, { id: 'logout', label: 'Logout', onSelect: onLogout })

  const viewItems: VscodeMenuEntry[] = [
    { id: 'output', label: 'Output', keybinding: outputShortcutLabel(isMacPlatform()), onSelect: toggleOutput },
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
      items: [{ id: 'shortcuts', label: 'Keyboard Shortcuts Reference', onSelect: onOpenHelp }],
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

        {/* Command center: identitas workspace aktif, atau input rename saat diminta menu. */}
        <div className="app-titlebar__center">
          {editingId ? (
            <Input
              className="app-titlebar__rename"
              value={draft}
              autoFocus
              spellCheck={false}
              aria-label="Workspace name"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setEditingId(null)
              }}
              onBlur={commitRename}
            />
          ) : onOpenPalette ? (
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
          {showLogout && (
            <IconTooltip label="Log out and return to the login screen">
              <button
                type="button"
                className="titlebar__action"
                aria-label="Logout"
                onClick={onLogout}
              >
                <span className="codicon codicon-sign-out" aria-hidden />
              </button>
            </IconTooltip>
          )}
        </div>
      </header>

      <div className="app-tabs">
        <VscodeEditorTabBar
          tabs={tabs}
          activeId={activeId}
          onActivate={onSelect}
          ariaLabel="Workspaces"
        />
        <div className="app-tabs__actions">
          <IconTooltip label="Workspace options: rename, delete or set the canvas background of the active workspace" disabled={!activeGroup} disabledReason="no workspace open">
            <button
              type="button"
              className="app-tabs__action"
              aria-label="Workspace options"
              disabled={!activeGroup}
              onClick={(e) => {
                // Klik kebab tidak berpindah workspace; menu ini bekerja pada workspace aktif.
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ x: r.left, y: r.bottom + MENU_GAP })
              }}
            >
              <span className="codicon codicon-ellipsis" aria-hidden />
            </button>
          </IconTooltip>
          <IconTooltip label="New workspace: open a folder, clone a repository or create a project">
            <button
              type="button"
              className="app-tabs__action"
              aria-label="New workspace"
              onClick={(e) => {
                // Three ways in, as nodeterm's Welcome cards: open a folder, clone, or start a new project.
                const r = e.currentTarget.getBoundingClientRect()
                setAddMenu({ x: r.left, y: r.bottom + MENU_GAP })
              }}
            >
              <span className="codicon codicon-add" aria-hidden />
            </button>
          </IconTooltip>
        </div>
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

      {menu && activeGroup && (
        <NodeContextMenu
          x={menu.x}
          y={menu.y}
          rows={[
            {
              label: 'Rename',
              onClick: () => startRename(activeGroup.projectId, activeGroup.projectName),
            },
            { label: 'Canvas Background…', onClick: openWorkspaceCanvasBackground },
            {
              label: 'Delete',
              danger: true,
              onClick: () => deleteWorkspace(activeGroup.projectId, activeGroup.projectName, activeGroup.sessions.length),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}
