// Pure ordering of workspace tiles. The server's `position` (ascending = display order) wins when every
// workspace carries one; otherwise the array order received is kept (before the order API exists, or for
// a payload without it). `position` is read structurally so this file needs no shared-type change.
import type { Workspace } from '../shared/workspace'

const positionOf = (w: Workspace): number | undefined => {
  const p = (w as { position?: unknown }).position
  return typeof p === 'number' && Number.isFinite(p) ? p : undefined
}

/** Display order: by `position` when all have one (stable for ties), else the received order. */
export function orderedWorkspaces(workspaces: Workspace[]): Workspace[] {
  if (workspaces.length === 0 || workspaces.some((w) => positionOf(w) === undefined)) return workspaces
  return workspaces.map((w, i) => ({ w, i })).sort((a, b) => (positionOf(a.w) as number) - (positionOf(b.w) as number) || a.i - b.i).map((x) => x.w)
}

/** `ids` with `id` moved to index `to` (clamped); the same array when nothing changes. */
export function moveId(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id)
  const target = Math.max(0, Math.min(ids.length - 1, to))
  if (from === -1 || from === target) return ids
  const next = ids.filter((x) => x !== id)
  next.splice(target, 0, id)
  return next
}

/** Same ids in the same order. */
export const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** Apply a pending (optimistic) id order to `list`; ignored when its id set no longer matches the list. */
export function applyPendingOrder(list: Workspace[], pending: readonly string[] | null): Workspace[] {
  if (!pending || pending.length !== list.length) return list
  const byId = new Map(list.map((w) => [w.id, w]))
  const out = pending.map((id) => byId.get(id))
  return out.every((w): w is Workspace => w !== undefined) ? out : list
}
