// One workspace tile in the rail: colored monogram, active indicator, agent badge (open workspace
// only), worktree dirty marker. Name/tooltip/aria come from the same functions as the header tab
// (`workspaceTabFields`), so the two surfaces never tell different stories.
import type { CSSProperties, KeyboardEvent, PointerEvent, MouseEvent } from 'react'
import { IconTooltip } from '@/components/ui/icon-button'
import type { SessionGroup } from './sessionList'
import { workspaceTabFields } from './WorkspaceTabDot'
import { workspaceTabDot } from './workspaceTabs'
import { worktreeSummary } from './WorkspaceWorktreeBadge'
import type { WorktreeStatus } from './workspaceWorktree.api'
import { monogram } from './workspaceTiles'
import { workspaceColorVar } from '../shared/workspaceColor'
import type { Workspace } from '../shared/workspace'

/** Where the insertion line is drawn while dragging. */
export type DropSide = 'before' | 'after' | null

export interface WorkspaceTileProps {
  group: SessionGroup
  workspace: Workspace
  worktree?: WorktreeStatus
  active: boolean
  /** Roving tabindex: exactly one tile of the group is 0. */
  tabbable: boolean
  dragging: boolean
  drop: DropSide
  /** Id of the canvas region the active tab controls. */
  controls: string
  onActivate: () => void
  onFocus: () => void
  onRename: () => void
  onMenu: (at: { x: number; y: number }) => void
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void
  /** True right after a drag ended: the click that follows it is not an activation. */
  swallowClick: () => boolean
}

export function WorkspaceTile(p: WorkspaceTileProps) {
  const { group, workspace: w, worktree: wt } = p
  const fields = workspaceTabFields(group, w, wt?.managed ? worktreeSummary(wt) : undefined)
  const status = workspaceTabDot(group)
  const dirty = wt?.managed === true && (wt.dirtyCount ?? 0) > 0
  const onContextMenu = (e: MouseEvent): void => { e.preventDefault(); p.onMenu({ x: e.clientX, y: e.clientY }) }
  return (
    <IconTooltip label={fields.tooltip ?? group.projectName} side="right">
      <button
        type="button"
        role="tab"
        className="ws-tile"
        data-slot="workspace-tile"
        data-ws-id={group.projectId}
        data-active={p.active ? 'true' : 'false'}
        data-dragging={p.dragging ? 'true' : undefined}
        data-drop={p.drop ?? undefined}
        aria-selected={p.active}
        aria-controls={p.controls}
        aria-label={fields.ariaLabel}
        tabIndex={p.tabbable ? 0 : -1}
        style={{ '--ws-tile': workspaceColorVar(w.color, w.colorShade) } as CSSProperties}
        onClick={() => { if (!p.swallowClick()) p.onActivate() }}
        onDoubleClick={p.onRename}
        onContextMenu={onContextMenu}
        onFocus={p.onFocus}
        onKeyDown={p.onKeyDown}
        onPointerDown={p.onPointerDown}
      >
        <span className="ws-tile__mono" aria-hidden>
          {monogram(group.projectName)}
          {(status === 'working' || status === 'attention') && <span className={`ws-dot__badge ws-dot__badge--${status}`} />}
          {dirty && <span className="ws-tile__dirty" />}
        </span>
        <span className="ws-tile__name" aria-hidden>{group.projectName}</span>
      </button>
    </IconTooltip>
  )
}
