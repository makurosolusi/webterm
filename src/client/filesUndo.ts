// Per-node undo stack for the Files node: rename/move, copy and trash. Revert = the inverse operation
// on the server (rename back, trash the copy, restore from trash). No DOM, no text.
import { leafOf, moveOne, removePaths, restoreMany, type Failure, type Moved, type TrashedItem } from './filesMutate'

export type UndoEntry =
  | { kind: 'move'; pairs: Moved[] }
  | { kind: 'copy'; paths: string[] }
  | { kind: 'trash'; items: TrashedItem[] }

/** Oldest entries fall off past this depth. */
export const UNDO_LIMIT = 20
const stacks = new Map<string, UndoEntry[]>()

export function pushUndo(nodeId: string, e: UndoEntry): void {
  const s = stacks.get(nodeId) ?? []
  s.push(e)
  if (s.length > UNDO_LIMIT) s.shift()
  stacks.set(nodeId, s)
}
export const popUndo = (nodeId: string): UndoEntry | undefined => stacks.get(nodeId)?.pop()
/** Take `e` out of the stack (toast Undo); false when it was already undone or fell off. */
export function takeUndo(nodeId: string, e: UndoEntry): boolean {
  const s = stacks.get(nodeId)
  const i = s?.indexOf(e) ?? -1
  if (i >= 0) s!.splice(i, 1)
  return i >= 0
}
export const clearUndo = (nodeId: string): void => { stacks.delete(nodeId) }

export interface RevertReport { done: string[]; failed: Failure[]; paths: string[] }

/** Apply the inverse of `e`; `paths` = absolute paths that exist again (for selection). */
export async function revert(e: UndoEntry): Promise<RevertReport> {
  if (e.kind === 'trash') return restoreMany(e.items)
  if (e.kind === 'copy') {
    const r = await removePaths(e.paths, e.paths.map(leafOf), false)
    return { done: r.done, failed: r.failed, paths: [] }
  }
  const out: RevertReport = { done: [], failed: [], paths: [] }
  for (const p of [...e.pairs].reverse()) {
    const r = await moveOne(p.to, p.from)
    out.done.push(...r.done)
    out.failed.push(...r.failed)
    if (r.done.length) out.paths.push(p.from)
  }
  return out
}
