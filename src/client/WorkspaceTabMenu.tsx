// Right-click / Shift+F10 menu of one workspace tab (rename, background, color, mute, delete).
import NodeContextMenu from './NodeContextMenu'
import { setWorkspaceMuted } from './osNotify.prefs'
import { openWorkspaceCanvasBackground } from './canvasBackground.open'

export interface WorkspaceTabMenuProps {
  x: number
  y: number
  projectId: string
  muted: boolean
  isActive: boolean
  onSelect: (id: string) => void
  onRename: () => void
  /** Absent = no Color… row. */
  onColor?: () => void
  onDelete: () => void
  onClose: () => void
}

export function WorkspaceTabMenu({ x, y, projectId, muted, isActive, onSelect, onRename, onColor, onDelete, onClose }: WorkspaceTabMenuProps) {
  return (
    <NodeContextMenu
      x={x}
      y={y}
      rows={[
        { label: 'Rename', onClick: onRename },
        // The background editor (Settings › Appearance) works on the active board, so open this one first.
        { label: 'Canvas Background…', onClick: () => { if (!isActive) onSelect(projectId); openWorkspaceCanvasBackground() } },
        ...(onColor ? [{ label: 'Color…', onClick: onColor }] : []),
        // Per-workspace mute lives here, next to the workspace (Settings › Notifications holds the global switches).
        muted
          ? { label: 'Unmute Notifications', onClick: () => setWorkspaceMuted(projectId, false) }
          : { label: 'Mute Notifications', onClick: () => setWorkspaceMuted(projectId, true) },
        { type: 'separator' },
        { label: 'Delete', danger: true, onClick: onDelete },
      ]}
      onClose={onClose}
    />
  )
}
