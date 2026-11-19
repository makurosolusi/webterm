// "All workspaces": quick pick of every workspace (color chip, name, worktree line, type-to-filter) with
// "New workspace…" last. It is the keyboard path to any workspace and the door to the ones scrolled out of the tab row
// (Chrome's "search tabs" pattern).
import { useMemo, type CSSProperties } from 'react'
import { VscodeQuickPick, type VscodeQuickPickItem } from '@/components/vscode/vscodeQuickPick'
import { worktreeSummary } from './WorkspaceWorktreeBadge'
import type { WorktreeStatus } from './workspaceWorktree.api'
import { workspaceColorVar } from '../shared/workspaceColor'
import type { Workspace } from '../shared/workspace'

export const ALL_WORKSPACES_LABEL = 'All workspaces'
export const NEW_WORKSPACE_ROW_ID = '\0new-workspace'
export const ALL_TRIGGER_SELECTOR = '[data-slot="workspace-all"]'

export interface AllWorkspacesProps {
  open: boolean
  workspaces: Workspace[]
  worktrees: Record<string, WorktreeStatus | undefined>
  activeId: string | null
  onClose: () => void
  onSelect: (id: string) => void
  onNew: () => void
}

export function AllWorkspaces({ open, workspaces, worktrees, activeId, onClose, onSelect, onNew }: AllWorkspacesProps) {
  const items = useMemo<VscodeQuickPickItem[]>(() => [
    ...workspaces.map((w) => {
      const wt = worktrees[w.id]
      return {
        id: w.id,
        label: w.name,
        description: w.id === activeId ? 'Open' : undefined,
        detail: wt?.managed ? worktreeSummary(wt) : undefined,
        icon: <span className="ws-chip" aria-hidden style={{ '--ws-chip': workspaceColorVar(w.color, w.colorShade) } as CSSProperties} />,
      }
    }),
    { id: NEW_WORKSPACE_ROW_ID, label: 'New workspace…', icon: <span className="codicon codicon-add" aria-hidden /> },
  ], [workspaces, worktrees, activeId])
  return (
    <VscodeQuickPick
      open={open}
      onClose={onClose}
      triggerSelector={ALL_TRIGGER_SELECTOR}
      ariaLabel={ALL_WORKSPACES_LABEL}
      placeholder="Select a workspace"
      emptyText="No matching workspaces"
      hint=""
      items={items}
      onSelect={(id) => { onClose(); if (id === NEW_WORKSPACE_ROW_ID) onNew(); else onSelect(id) }}
    />
  )
}
