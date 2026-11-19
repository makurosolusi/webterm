// Pure builders of the File / View / Help menu model for the title bar (and the rail menu).
// File: New → Rename/Delete (workspace aktif) → Settings → Logout, seperti File di VS Code
// (aksi dokumen, lalu Preferences, lalu keluar). Delete tidak diberi warna bahaya: VS Code tak
// mewarnai item menu, dan konfirmasi `window.confirm` sudah menjaga aksinya.
import type { VscodeMenu, VscodeMenuEntry } from '@/components/vscode/vscodeMenuBar'
import { clearOutput, toggleOutput } from './output/outputCommands'
import { openWorkspaceCreate } from './workspaceCreate/WorkspaceCreateHost'
import { openSetup } from './setup/setup.open'
import { HEADER_MODES, type HeaderMode } from './headerMode.store'
import { HEADER_MODE_LABEL } from './headerMode.commands'

/** The active workspace as the menus need it (null: nothing open, so no per-workspace rows). */
export interface MenuActiveWorkspace {
  projectId: string
  projectName: string
  sessionCount: number
}

export interface WorkspaceMenuInput {
  active: MenuActiveWorkspace | null
  layoutKey: string | undefined
  outputKey: string | undefined
  onNewWorkspace: () => void
  onRename: (id: string) => void
  onDelete: (id: string, name: string, sessions: number) => void
  onNewFiles?: () => void
  onOpenSettings?: () => void
  onOpenAccount?: () => void
  onLogout?: () => void
  showLogout?: boolean
  onOpenHelp?: () => void
  onToggleLayout?: () => void
  /** View > Header radio: the stored mode, its setter and the chord that toggles Hidden (absent: no submenu). */
  headerMode?: HeaderMode
  onSetHeaderMode?: (mode: HeaderMode) => void
  headerKey?: string
  /** View > Show Rail Labels: the pinned-rail preference, its toggle and chord (absent: no row). */
  railLabels?: boolean
  onToggleRailLabels?: () => void
  railLabelsKey?: string
}

/** View > Header: Full / Compact / Hidden as a radio group; the Hidden row shows the toggle chord. */
function headerSubmenu(current: HeaderMode, set: (mode: HeaderMode) => void, key: string | undefined): VscodeMenuEntry {
  return {
    id: 'header',
    label: 'Header',
    submenu: HEADER_MODES.map((mode) => ({
      id: `header-${mode}`, label: HEADER_MODE_LABEL[mode], checked: mode === current, keybinding: mode === 'hidden' ? key : undefined, onSelect: () => set(mode),
    })),
  }
}

/** Builds File / View / Help from props; Help is absent without `onOpenHelp`. */
export function buildWorkspaceMenus(i: WorkspaceMenuInput): VscodeMenu[] {
  const { active } = i
  const fileItems: VscodeMenuEntry[] = [
    { id: 'new-workspace', label: 'New Workspace', onSelect: () => i.onNewWorkspace() },
    { id: 'clone-repository', label: 'Clone Repository…', onSelect: () => openWorkspaceCreate('clone') },
    { id: 'new-project', label: 'New Project…', onSelect: () => openWorkspaceCreate('project') },
  ]
  if (active && i.onNewFiles) fileItems.push({ type: 'separator' }, { id: 'new-files', label: 'New Files Node', onSelect: i.onNewFiles })
  if (active) {
    fileItems.push(
      { type: 'separator' },
      { id: 'rename-workspace', label: 'Rename Workspace…', onSelect: () => i.onRename(active.projectId) },
      { id: 'delete-workspace', label: 'Delete Workspace', onSelect: () => i.onDelete(active.projectId, active.projectName, active.sessionCount) },
    )
  }
  if (i.onOpenSettings) fileItems.push({ type: 'separator' }, { id: 'settings', label: 'Settings…', onSelect: i.onOpenSettings })
  if (i.showLogout && i.onOpenAccount) fileItems.push({ type: 'separator' }, { id: 'account', label: 'Account…', onSelect: i.onOpenAccount })
  if (i.showLogout && i.onLogout) fileItems.push(...(i.onOpenAccount ? [] : [{ type: 'separator' } as const]), { id: 'logout', label: 'Sign out', onSelect: i.onLogout })

  const viewItems: VscodeMenuEntry[] = [
    ...(i.onToggleLayout ? [{ id: 'toggle-layout', label: 'Toggle Tab Layout', keybinding: i.layoutKey, disabled: !active, onSelect: i.onToggleLayout }] : []),
    ...(i.headerMode && i.onSetHeaderMode ? [headerSubmenu(i.headerMode, i.onSetHeaderMode, i.headerKey)] : []),
    ...(i.onToggleRailLabels ? [{ id: 'rail-labels', label: 'Show Rail Labels', checked: i.railLabels === true, keybinding: i.railLabelsKey, onSelect: i.onToggleRailLabels }] : []),
    { id: 'output', label: 'Output', keybinding: i.outputKey, onSelect: toggleOutput },
    { id: 'clear-output', label: 'Clear Output', onSelect: () => void clearOutput() },
  ]
  const menus: VscodeMenu[] = [
    { id: 'file', label: 'File', items: fileItems },
    { id: 'view', label: 'View', items: viewItems },
  ]
  if (i.onOpenHelp) {
    menus.push({
      id: 'help',
      label: 'Help',
      items: [{ id: 'shortcuts', label: 'Keyboard Shortcuts Reference', onSelect: i.onOpenHelp }, { id: 'setup', label: 'Set up webterm…', onSelect: () => openSetup() }],
    })
  }
  return menus
}
