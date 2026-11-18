// Workspace navigation in the shared registry (palette, shortcut dispatcher, Keyboard Shortcuts page):
// next / previous workspace in display order, and the pinned-rail toggle. Registered by App in every
// header mode, so the keyboard path never depends on which surface shows the workspaces.
import { useMemo } from 'react'
import { useRegisterCommands, type Command } from './commandRegistry'
import { toggleRailLabels } from './railLabels.store'
import { orderedWorkspaces } from './workspaceRail.order'
import type { Workspace } from '../shared/workspace'

export const WORKSPACE_NEXT_ID = 'workspace.next'
export const WORKSPACE_PREV_ID = 'workspace.previous'
export const RAIL_LABELS_ID = 'view.rail.labels'
export const WORKSPACE_NEXT_KEY = 'Mod+Alt+ArrowDown'
export const WORKSPACE_PREV_KEY = 'Mod+Alt+ArrowUp'

/** Id of the workspace `dir` steps from the active one (wraps); null with fewer than two workspaces. */
export function neighborWorkspaceId(ids: readonly string[], activeId: string | null, dir: -1 | 1): string | null {
  if (ids.length < 2) return null
  const at = activeId ? ids.indexOf(activeId) : -1
  return ids[at === -1 ? (dir === 1 ? 0 : ids.length - 1) : (at + dir + ids.length) % ids.length]
}

/** The three commands for the current workspaces; `select` is App's workspace switch. */
export function workspaceNavCommands(workspaces: Workspace[], activeId: string | null, select: (id: string) => void): Command[] {
  const ids = orderedWorkspaces(workspaces).map((w) => w.id)
  const go = (dir: -1 | 1) => () => { const id = neighborWorkspaceId(ids, activeId, dir); if (id) select(id) }
  return [
    { id: WORKSPACE_NEXT_ID, label: 'Workspace: Next', defaultKey: WORKSPACE_NEXT_KEY, run: go(1) },
    { id: WORKSPACE_PREV_ID, label: 'Workspace: Previous', defaultKey: WORKSPACE_PREV_KEY, run: go(-1) },
    { id: RAIL_LABELS_ID, label: 'View: Toggle Rail Labels', run: toggleRailLabels },
  ]
}

/** Registers the commands while the workspace chrome is mounted. */
export function useWorkspaceNavCommands(workspaces: Workspace[], activeId: string | null, select: (id: string) => void): void {
  useRegisterCommands(useMemo(() => workspaceNavCommands(workspaces, activeId, select), [workspaces, activeId, select]))
}
