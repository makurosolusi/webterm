// Workspace tab strip: one `VscodeEditorTab` per workspace plus the trailing `+` button. Tabs reorder by drag or
// Alt+Shift+Left/Right when `onReorder` is given (the order is saved by the caller, `workspaceTabs.reorder`).
// Worktree state on the tab: VS Code's dirty dot plus branch in the tooltip.
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import { VscodeEditorTabBar } from '@/components/vscode/vscodeEditorTabBar'
import type { VscodeEditorTab } from '@/components/vscode/vscodeEditorTabBar'
import type { SessionGroup } from './sessionList'
import { workspaceTabFields } from './WorkspaceTabDot'
import { WorkspaceTabRename } from './WorkspaceTabRename'
import { worktreeSummary } from './WorkspaceWorktreeBadge'
import type { WorktreeStatus } from './workspaceWorktree.api'
import type { PointAt } from './useWorkspaceTabActions'
import { dropSide, useTabsDrag } from './workspaceTabs.drag'
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
  /** Move workspace `id` to display index `to`. Absent = the tabs cannot be reordered. */
  onMove?: (id: string, to: number) => void
}

export function WorkspaceTabStrip({ groups, workspaces, worktrees, activeId, editingId, onSelect, onEdit, onRenameWorkspace, onTabMenu, onAddMenu, onMove }: WorkspaceTabStripProps): ReactNode {
  const ids = groups.map((g) => g.projectId)
  const drag = useTabsDrag({ ids, onMove: (id, to) => onMove?.(id, to) })
  const [refocus, setRefocus] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  // Moving a node in the DOM can drop its focus; put it back on the tab that was moved by keyboard.
  useLayoutEffect(() => {
    if (!refocus) return
    document.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(refocus)}"]`)?.focus()
    setRefocus(null)
  }, [refocus, ids.join('\n')])

  const tabs: VscodeEditorTab[] = groups.map((g, i) => {
    const wt = worktrees[g.projectId]
    return {
      id: g.projectId,
      label: g.projectName,
      ...workspaceTabFields(g, workspaces.find((x) => x.id === g.projectId), wt?.managed ? worktreeSummary(wt) : undefined),
      dirty: wt?.managed === true && (wt.dirtyCount ?? 0) > 0,
      dragging: drag.view?.id === g.projectId,
      drop: dropSide(drag.view, i, groups.length),
      editor: editingId === g.projectId
        ? <WorkspaceTabRename initial={g.projectName} onCommit={(name) => onRenameWorkspace(g.projectId, name)} onClose={() => onEdit(null)} />
        : undefined,
    }
  })
  const movable = onMove !== undefined && groups.length > 1
  return (
    <>
      <VscodeEditorTabBar
        tabs={tabs}
        activeId={activeId}
        onActivate={onSelect}
        onDoubleClick={onEdit}
        onContextMenu={onTabMenu}
        onTabPointerDown={movable ? drag.begin : undefined}
        swallowClick={drag.wasDragged}
        onMoveTab={movable ? (id, dir) => {
          const to = ids.indexOf(id) + dir
          if (to < 0 || to >= ids.length) return
          setRefocus(id)
          setAnnounce(`Moved ${groups[ids.indexOf(id)].projectName} to position ${to + 1} of ${ids.length}`)
          onMove?.(id, to)
        } : undefined}
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
      <span className="sr-only" role="status">{announce}</span>
    </>
  )
}
