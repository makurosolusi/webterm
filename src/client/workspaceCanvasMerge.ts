// A server canvas push (`t:'canvas'`) applied to a stored-shape board: the save queue folds it into
// every unsent payload, the saver into the locked one and the `workspaces` list, so no save written
// after the push drops what the server added or resurrects what it removed.
import type { CanvasMsg } from '../shared/protocol'
import type { Workspace } from '../shared/workspace'

/** `ws` plus the pushed nodes/cables whose ids it lacks, minus the removed nodes and every cable
 *  touching them; everything else (`updatedAt` too) unchanged. Same object when nothing changes. */
export function mergeCanvasPush(ws: Workspace, push: Pick<CanvasMsg, 'nodes' | 'bridges' | 'removed'>): Workspace {
  const gone = new Set(push.removed ?? [])
  const nodeIds = new Set(ws.nodes.map((n) => n.id))
  const bridgeIds = new Set(ws.bridges.map((b) => b.id))
  const added = push.nodes.filter((n) => !nodeIds.has(n.id) && !gone.has(n.id))
  const cables = push.bridges.filter((b) => !bridgeIds.has(b.id))
  const kept = gone.size ? ws.nodes.filter((n) => !gone.has(n.id)) : ws.nodes
  const keptCables = gone.size ? ws.bridges.filter((b) => !gone.has(b.source) && !gone.has(b.target)) : ws.bridges
  if (!added.length && !cables.length && kept.length === ws.nodes.length && keptCables.length === ws.bridges.length) return ws
  return { ...ws, nodes: [...kept, ...added], bridges: [...keptCables, ...cables] }
}
