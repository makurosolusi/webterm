// Workspace group of the rail (Compact and Hidden header modes; Full keeps the tab strip): colored tiles
// in a vertical WAI-ARIA tablist, `+` and "All workspaces". The group is the rail's one flexible region:
// it scrolls when the window is short (active tile sticky) and "All workspaces" appears only then.
// Menu, rename and color are the header's own (`WorkspaceTabMenu` etc. via `workspaceTabUi.store`).
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { buildSessionList } from './sessionList'
import { useWorktreeStatuses } from './WorkspaceWorktreeBadge'
import { WorkspaceTile } from './WorkspaceRail.tile'
import { AllWorkspaces, ALL_WORKSPACES_LABEL } from './WorkspaceRail.all'
import { RailRename } from './WorkspaceRail.rename'
import { useWorkspaceReorder } from './workspaceRail.reorder'
import { useRailDrag } from './workspaceRail.drag'
import { useTilesOverflow } from './workspaceRail.overflow'
import { focusIndex, tileKeyIntent } from './workspaceRail.keys'
import { setAddMenu, setEditingId, setTabMenu, useWorkspaceTabUi } from './workspaceTabUi.store'
import { codicon } from './dockCodicon'
import { WORKSPACE_CANVAS_ID } from './workspaceTiles'
import type { AgentStatus, Workspace, WsNode } from '../shared/workspace'

/** Gap between a rail button and the menu opened beside it. */
const MENU_GAP_PX = 6

export interface WorkspaceRailProps {
  workspaces: Workspace[]
  activeId: string | null
  liveActiveNodes: WsNode[] | null
  statuses: Record<string, AgentStatus>
  onSelect: (id: string) => void
  onRenameWorkspace: (id: string, name: string) => void | Promise<unknown>
  /** Persist the full order (ids top to bottom). Absent = tiles cannot be reordered. */
  onReorder?: (ids: string[]) => Promise<void>
}

export function WorkspaceRail({ workspaces, activeId, liveActiveNodes, statuses, onSelect, onRenameWorkspace, onReorder }: WorkspaceRailProps) {
  const reorder = useWorkspaceReorder(workspaces, onReorder)
  const { items } = reorder
  const groups = useMemo(() => buildSessionList(items, liveActiveNodes, activeId, statuses, ''), [items, liveActiveNodes, activeId, statuses])
  const worktrees = useWorktreeStatuses(items)
  const { editingId } = useWorkspaceTabUi()
  const listRef = useRef<HTMLDivElement>(null)
  const overflow = useTilesOverflow(listRef, items.length)
  const [roving, setRoving] = useState<string | null>(null)
  const [allOpen, setAllOpen] = useState(false)
  const [announce, setAnnounce] = useState('')
  const refocus = useRef<string | null>(null)
  const ids = items.map((w) => w.id)
  const tabbable = roving && ids.includes(roving) ? roving : activeId && ids.includes(activeId) ? activeId : ids[0]

  const tileEl = (id: string): HTMLElement | undefined => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-ws-id]') ?? [])].find((el) => el.dataset.wsId === id)
  const drag = useRailDrag({ ids, tileElements: () => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-ws-id]') ?? [])], onMove: reorder.move })
  // Moving a node in the DOM drops its focus; put it back on the tile that was moved by keyboard.
  useLayoutEffect(() => {
    if (!refocus.current) return
    tileEl(refocus.current)?.focus()
    refocus.current = null
  })

  const openMenuAt = (id: string, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setTabMenu({ id, x: r.right + MENU_GAP_PX, y: r.top })
  }
  const openAddMenu = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setAddMenu({ x: r.right + MENU_GAP_PX, y: r.top })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string): void => {
    const intent = tileKeyIntent(e)
    if (!intent) return
    e.preventDefault()
    const from = ids.indexOf(id)
    if (intent.kind === 'focus') tileEl(ids[focusIndex(intent.to, from, ids.length)])?.focus()
    else if (intent.kind === 'activate') onSelect(id)
    else if (intent.kind === 'rename') setEditingId(id)
    else if (intent.kind === 'menu') openMenuAt(id, e.currentTarget)
    else if (reorder.enabled) {
      const to = from + intent.dir
      if (to < 0 || to >= ids.length) return
      refocus.current = id
      reorder.move(id, to)
      setAnnounce(`Moved ${items[from].name} to position ${to + 1} of ${ids.length}`)
    }
  }

  return (
    <div className="ws-rail" data-slot="workspace-rail">
      <div ref={listRef} className="ws-rail__tabs" role="tablist" aria-orientation="vertical" aria-label="Workspaces">
        {groups.map((g, i) => {
          const w = items[i]
          const slot = drag.view?.slot ?? null
          return (
            <div key={g.projectId} className="ws-rail__cell" data-active={g.isActive ? 'true' : 'false'}>
              <WorkspaceTile
                group={g}
                workspace={w}
                worktree={worktrees[g.projectId]}
                active={g.isActive}
                tabbable={g.projectId === tabbable}
                dragging={drag.view?.id === g.projectId}
                drop={slot === i ? 'before' : slot === ids.length && i === ids.length - 1 ? 'after' : null}
                controls={WORKSPACE_CANVAS_ID}
                onActivate={() => onSelect(g.projectId)}
                onFocus={() => setRoving(g.projectId)}
                onRename={() => setEditingId(g.projectId)}
                onMenu={(at) => setTabMenu({ id: g.projectId, ...at })}
                onKeyDown={(e) => onKeyDown(e, g.projectId)}
                onPointerDown={reorder.enabled ? (e) => drag.begin(e, g.projectId) : undefined}
                swallowClick={drag.wasDragged}
              />
            </div>
          )
        })}
      </div>
      <div className="ws-rail__actions">
        {overflow && (
          <IconButton className="ws-rail__btn" label={ALL_WORKSPACES_LABEL} side="right" data-slot="workspace-rail-all" aria-haspopup="dialog" onClick={() => setAllOpen(true)}>
            <span className="vscode-activity-bar__icon" aria-hidden>{codicon('list-flat')}</span>
          </IconButton>
        )}
        <IconButton className="ws-rail__btn" label="New workspace" tooltip="New workspace: open a folder, clone a repository or create a project" side="right"
          onClick={(e) => openAddMenu(e.currentTarget)}>
          <span className="vscode-activity-bar__icon" aria-hidden>{codicon('add')}</span>
        </IconButton>
      </div>
      <span className="ws-rail__sr" role="status">{announce}</span>
      {editingId && items.some((w) => w.id === editingId) && (
        <RailRename key={editingId} groupRef={listRef} id={editingId} initial={items.find((w) => w.id === editingId)?.name ?? ''}
          onCommit={(name) => onRenameWorkspace(editingId, name)} onClose={() => setEditingId(null)} />
      )}
      <AllWorkspaces open={allOpen} workspaces={items} worktrees={worktrees} activeId={activeId} onClose={() => setAllOpen(false)}
        onSelect={onSelect} onNew={() => { const el = listRef.current; if (el) openAddMenu(el) }} />
    </div>
  )
}
