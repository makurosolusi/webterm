// Saving a reorder from the rail: one PUT of the full order, and ONE refetch-and-retry when the server says a workspace
// appeared between the client's read and the PUT (`bad_order` / `missing`). The answer is merged into the list, not swapped in,
// so a board holding unsent edits keeps them.
import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { WORKSPACE_ORDER_ERROR } from '../shared/workspace.order'
import type { Workspace } from '../shared/workspace'
import { errorCause } from '@/components/ui/action'
import { fetchWorkspaces } from './api'
import { putWorkspaceOrder } from './workspaceOrder.api'
import { addNewWorkspaces } from './workspaceList.push'
import { applyServerOrder } from './workspaceOrder.list'

const MISSING_REFUSAL = `${WORKSPACE_ORDER_ERROR} (missing)`

/** `ids` kept in order, ids no longer stored dropped, stored ids it lacks appended. */
export function reconcileOrder(ids: readonly string[], stored: readonly Workspace[]): string[] {
  const have = new Set(stored.map((w) => w.id))
  const kept = ids.filter((id) => have.has(id))
  const known = new Set(kept)
  return [...kept, ...stored.map((w) => w.id).filter((id) => !known.has(id))]
}

/** Persist `ids`; resolves the list the server answered with. Throws a contextual error when the retry fails too. */
export async function saveWorkspaceOrder(ids: readonly string[]): Promise<Workspace[]> {
  try {
    return await putWorkspaceOrder(ids)
  } catch (first) {
    if (!(first instanceof Error) || !first.message.includes(MISSING_REFUSAL)) throw first
    try {
      return await putWorkspaceOrder(reconcileOrder(ids, await fetchWorkspaces()))
    } catch (second) {
      throw new Error(`A workspace was added while reordering; refreshing the list and saving again failed: ${errorCause(second)}`, { cause: second })
    }
  }
}

/** `onReorder` for the rail: save, then follow the server's order in the list state. */
export function useWorkspaceOrderSave(setWorkspaces: Dispatch<SetStateAction<Workspace[]>>): (ids: string[]) => Promise<void> {
  return useCallback(async (ids: string[]) => {
    const saved = await saveWorkspaceOrder(ids)
    setWorkspaces((prev) => applyServerOrder(addNewWorkspaces(prev, saved), saved.map((w) => w.id)))
  }, [setWorkspaces])
}
