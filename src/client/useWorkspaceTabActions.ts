// State + confirm flow behind the workspace tab surfaces (tab menu, `+` menu, rename, color, delete).
import { useState } from 'react'
import { deleteWorkspaceMessage } from './workspaceMenu'
import { offerRemoveWorktree } from './workspaceWorktree.api'
import type { Workspace } from '../shared/workspace'

export interface PointAt {
  x: number
  y: number
}

/** Owns the tab-surface state; `deleteWorkspace` is the single confirm path for File and tab menus. */
export function useWorkspaceTabActions(workspaces: Workspace[], onDeleteWorkspace: (id: string) => void) {
  /** Tab context menu: which workspace it acts on (not necessarily the active one) and where. */
  const [menu, setMenu] = useState<({ id: string } & PointAt) | null>(null)
  const [addMenu, setAddMenu] = useState<PointAt | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [colorId, setColorId] = useState<string | null>(null)

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

  return { menu, setMenu, addMenu, setAddMenu, editingId, setEditingId, colorId, setColorId, deleteWorkspace }
}
