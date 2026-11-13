// Isi context menu baris sidebar Sessions. Murni: callback datang dari panel, jadi urutan dan
// label item (mengikuti menu VS Code: aksi utama, pemisah, Copy Path, pemisah, aksi destruktif)
// bisa diuji tanpa DOM.
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import type { TreeTarget } from './SessionRow'

export interface SessionMenuActions {
  onFocusNode: (id: string) => void
  onCloseSession: (id: string) => void
  /** Opens the rename prompt; only offered for a session the target marks `renamable`. */
  onRenameSession?: (id: string) => void
  onReopenSession?: (id: string) => void
  onSelectWorkspace: (id: string) => void
  /** Lipat/buka grup; `expanded` = keadaan SEBELUM aksi. */
  onToggleGroup: (key: string, expanded: boolean) => void
  onCopyText: (text: string) => void
}

const item = (id: string, label: string, onSelect: () => void, disabled = false): VscodeMenuItem => ({
  type: 'item',
  id,
  label,
  onSelect,
  disabled,
})

const SEPARATOR: VscodeMenuItem = { type: 'separator' }

/** Shared with the group header's inline action, so both paths read as one action. */
export const SWITCH_WORKSPACE_LABEL = 'Switch to Workspace'

const copyPath = (path: string | undefined, a: SessionMenuActions): VscodeMenuItem =>
  item('copy-path', 'Copy Path', () => path && a.onCopyText(path), !path)

/** Item menu untuk satu target pohon; `expanded` hanya dibaca untuk target grup. */
export function buildSessionMenu(target: TreeTarget, expanded: boolean, a: SessionMenuActions): VscodeMenuItem[] {
  switch (target.kind) {
    case 'session':
      return [
        item('reveal', 'Reveal on Canvas', () => a.onFocusNode(target.id)),
        // Disabled off the open board: the rename writes the canvas node, which only that board has.
        item('rename', 'Rename…', () => a.onRenameSession?.(target.id), !target.renamable || !a.onRenameSession),
        SEPARATOR,
        copyPath(target.path, a),
        SEPARATOR,
        item('end', 'End Session', () => a.onCloseSession(target.id)),
      ]
    case 'node':
      return [item('reveal', 'Reveal on Canvas', () => a.onFocusNode(target.id)), SEPARATOR, copyPath(target.path, a)]
    case 'reopen':
      return [
        item('reopen', 'Reopen Session', () => a.onReopenSession?.(target.id), !a.onReopenSession),
        SEPARATOR,
        copyPath(target.path, a),
      ]
    case 'group': {
      const toggle = item('toggle', expanded ? 'Collapse' : 'Expand', () => a.onToggleGroup(target.key, expanded))
      if (!target.projectId) return [toggle]
      const projectId = target.projectId
      return [
        item('switch', SWITCH_WORKSPACE_LABEL, () => a.onSelectWorkspace(projectId), target.isActive === true),
        SEPARATOR,
        toggle,
      ]
    }
  }
}
