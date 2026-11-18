// Confirm flow + store binding behind the workspace tab surfaces (tab menu, `+` menu, rename, color, delete).
import { deleteWorkspaceMessage } from './workspaceMenu'
import { offerRemoveWorktree } from './workspaceWorktree.api'
import { setAddMenu, setColorId, setEditingId, setTabMenu, useWorkspaceTabUi } from './workspaceTabUi.store'
import type { Workspace } from '../shared/workspace'

export type { PointAt } from './workspaceTabUi.store'

/** Binds the shared tab-surface state; `deleteWorkspace` is the single confirm path for File and tab menus. */
export function useWorkspaceTabActions(workspaces: Workspace[], onDeleteWorkspace: (id: string) => void) {
  // State lives in `workspaceTabUi.store` so the header strip and the rail tiles share one set of hosts.
  const { menu, addMenu, editingId, colorId } = useWorkspaceTabUi()

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

  return { menu, setMenu: setTabMenu, addMenu, setAddMenu, editingId, setEditingId, colorId, setColorId, deleteWorkspace }
}
