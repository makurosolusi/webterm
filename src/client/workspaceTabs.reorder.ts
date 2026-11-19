// Optimistic reorder of the rail tiles: the new order shows at once, the save runs in the background, a
// failure puts the old order back and says why (with Retry). The pending order is dropped as soon as
// the workspace list's own order changes (the server's answer, or another window's change), so it can
// never outlive the truth it was a guess of.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorCause } from '@/components/ui/action'
import { ACTION_NOTICE_KEY, closeNotice, showNotice } from './workspaceSave.notice'
import { applyPendingOrder, moveId, orderedWorkspaces, sameOrder } from './workspaceOrder.list'
import type { Workspace } from '../shared/workspace'

export const REORDER_FAILED_TITLE = 'Could not reorder workspaces'

export interface WorkspaceReorder {
  /** Workspaces in display order (pending order applied). */
  items: Workspace[]
  /** Reordering is possible: a save handler was supplied and there is more than one workspace. */
  enabled: boolean
  /** Move `id` to display index `to`. */
  move: (id: string, to: number) => void
}

/** `onReorder(ids)` persists the full order; absent = the rail is read-only. */
export function useWorkspaceReorder(workspaces: Workspace[], onReorder?: (ids: string[]) => Promise<void>): WorkspaceReorder {
  const [pending, setPending] = useState<string[] | null>(null)
  const base = useMemo(() => orderedWorkspaces(workspaces), [workspaces])
  const baseKey = base.map((w) => w.id).join('\n')
  useEffect(() => setPending(null), [baseKey])
  const items = useMemo(() => applyPendingOrder(base, pending), [base, pending])
  const latest = useRef({ items, onReorder })
  latest.current = { items, onReorder }

  const save = useCallback(async (ids: string[], previous: string[] | null): Promise<void> => {
    setPending(ids)
    try {
      await latest.current.onReorder?.(ids)
      closeNotice(ACTION_NOTICE_KEY)
    } catch (e) {
      setPending(previous)
      showNotice(ACTION_NOTICE_KEY, {
        severity: 'error',
        title: REORDER_FAILED_TITLE,
        message: `The order was restored. ${errorCause(e)}`,
        actions: [{ label: 'Retry', onClick: () => void save(ids, previous) }],
      })
    }
  }, [])

  const move = useCallback((id: string, to: number) => {
    const { items: cur, onReorder: fn } = latest.current
    if (!fn) return
    const ids = cur.map((w) => w.id)
    const next = moveId(ids, id, to)
    if (sameOrder(next, ids)) return
    void save(next, pending)
  }, [save, pending])

  return { items, enabled: onReorder !== undefined && workspaces.length > 1, move }
}
