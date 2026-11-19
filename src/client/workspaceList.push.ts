// Central changes the workspace list itself: `t:'workspaces'` (workspace.create) makes this window
// fetch the list and add the boards it lacks; a `t:'canvas'` frame with `name` (workspace.rename)
// renames the mounted board the way the header's Rename does (activeWsRef = source of the next save
// payload, plus the header state). The list entries, the locked payload and unsent saves take the
// name in `workspaceSaver.ts` / `workspaceSaveQueue.ts` through `mergeCanvasPush`.
//
// Logic lives outside JSX so it can be asserted without a DOM (same reason as `./workspaceView.push`).
import { useEffect } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { CanvasMsg } from '../shared/protocol'
import type { Workspace } from '../shared/workspace'
import { fetchWorkspaces } from './api'
import { reported } from './workspaceActionError'
import { applyServerOrder } from './workspaceOrder.list'
import { subscribeCanvas, subscribeWorkspaces } from './ws'

export interface ListTarget {
  activeWsRef: RefObject<Workspace | null>
  setActiveWs: Dispatch<SetStateAction<Workspace | null>>
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>
}

/** `prev` plus the boards of `fresh` it lacks; existing entries (maybe holding unsaved edits) are kept as is. Same array when none. */
export function addNewWorkspaces(prev: Workspace[], fresh: readonly Workspace[]): Workspace[] {
  const known = new Set(prev.map((w) => w.id))
  const added = fresh.filter((w) => !known.has(w.id))
  return added.length ? [...prev, ...added] : prev
}

/** `prev` without `ws`, then `ws` at the END (a new workspace never jumps to the front: the persisted order appends). */
export const appendWorkspace = (prev: Workspace[], ws: Workspace): Workspace[] => [...prev.filter((w) => w.id !== ws.id), ws]

/** Rename the mounted board from a pushed `name`; false when the frame carries none or is for another board. */
export function applyRenamePush(t: Pick<ListTarget, 'activeWsRef' | 'setActiveWs'>, msg: CanvasMsg): boolean {
  const cur = t.activeWsRef.current
  const name = msg.name
  if (name === undefined || cur?.id !== msg.workspaceId || cur.name === name) return false
  t.activeWsRef.current = { ...cur, name }
  t.setActiveWs((ws) => (ws && ws.id === msg.workspaceId ? { ...ws, name } : ws))
  return true
}

/** Follow Central's creates and renames for as long as the caller is mounted; a failed refresh is reported, not thrown. */
export function useWorkspaceListPush(t: ListTarget): void {
  const { activeWsRef, setActiveWs, setWorkspaces } = t
  useEffect(() => {
    // `order` (after a reorder in any window) re-sorts the list; a create carries none and just appends.
    const refresh = reported('refresh the workspace list', async (_list: string, order?: string[]) => {
      const fresh = await fetchWorkspaces()
      setWorkspaces((prev) => { const merged = addNewWorkspaces(prev, fresh); return order ? applyServerOrder(merged, order) : merged })
    })
    const offList = subscribeWorkspaces((msg) => { void refresh('workspaces', msg.order) })
    const offCanvas = subscribeCanvas((msg) => { applyRenamePush({ activeWsRef, setActiveWs }, msg) })
    return () => { offList(); offCanvas() }
  }, [activeWsRef, setActiveWs, setWorkspaces])
}
