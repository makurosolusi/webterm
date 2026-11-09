// A server canvas push (`t:'canvas'`) applied to a stored-shape board: the save queue folds it into
// every unsent payload, the saver into the locked one and the `workspaces` list, so no save written
// after the push drops what the server added, resurrects what it removed or reverts what it patched.
import { CANVAS_PATCH_KEYS, type CanvasMsg } from '../shared/protocol'
import type { Workspace, WsNode } from '../shared/workspace'

/** `node` with the patchable fields of `pushed` (absent there = absent here). */
export function withPatchedFields<T extends Partial<WsNode>>(node: T, pushed: WsNode): T {
  const next: Record<string, unknown> = { ...node }
  for (const key of CANVAS_PATCH_KEYS) {
    if (pushed[key] === undefined) delete next[key]
    else next[key] = pushed[key]
  }
  return next as T
}

/** `ws` plus the pushed nodes/cables whose ids it lacks, minus the removed nodes and every cable
 *  touching them and the unlinked cables, with updated nodes' patchable fields taken from the push;
 *  everything else (`updatedAt` too) unchanged. Same object when nothing changes. */
export function mergeCanvasPush(ws: Workspace, push: Pick<CanvasMsg, 'nodes' | 'bridges' | 'removed' | 'updated' | 'unlinked'>): Workspace {
  const gone = new Set(push.removed ?? [])
  const unlinked = new Set(push.unlinked ?? [])
  const updated = new Map((push.updated ?? []).map((n) => [n.id, n]))
  const nodeIds = new Set(ws.nodes.map((n) => n.id))
  const bridgeIds = new Set(ws.bridges.map((b) => b.id))
  const added = push.nodes.filter((n) => !nodeIds.has(n.id) && !gone.has(n.id))
  const cables = push.bridges.filter((b) => !bridgeIds.has(b.id) && !unlinked.has(b.id))
  const kept = gone.size ? ws.nodes.filter((n) => !gone.has(n.id)) : ws.nodes
  const patched = updated.size ? kept.map((n) => { const p = updated.get(n.id); return p ? withPatchedFields(n, p) : n }) : kept
  const keptCables = gone.size || unlinked.size ? ws.bridges.filter((b) => !gone.has(b.source) && !gone.has(b.target) && !unlinked.has(b.id)) : ws.bridges
  const unchanged = !updated.size || ws.nodes.every((n) => !updated.has(n.id))
  if (unchanged && !added.length && !cables.length && kept.length === ws.nodes.length && keptCables.length === ws.bridges.length) return ws
  return { ...ws, nodes: [...patched, ...added], bridges: [...keptCables, ...cables] }
}
