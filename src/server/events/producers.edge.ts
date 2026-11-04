// `edge.change` producer: on a workspace save, what each node is now wired to versus before
// (browser nodes + context-link peers, the same `linkEntries` the visible link note announces).
// linkNote subscribes to this instead of polling every second.
import type { Workspace } from '../../shared/workspace'
import { linkEntries } from '../linkNote'
import { createLogger } from '../logs'
import { recordEvent } from './producers'

const log = createLogger('events')

/** Per-node cap and per-save cap on the diff carried in the payload. */
export const EDGE_CHANGE_MAX = 50

/** Net cable change seen from one node. */
export interface EdgeChange { nodeId: string; added: string[]; removed: string[]; renamed: string[] }

/** Diff of every node's links `prev` → `next`; nodes gone from `next` are reported by their peers. */
export function edgeChanges(prev: Workspace | null | undefined, next: Workspace): EdgeChange[] {
  const out: EdgeChange[] = []
  for (const n of next.nodes ?? []) {
    const before = new Map((prev ? linkEntries(prev, n.id) : []).map((e) => [e.id, e]))
    const after = linkEntries(next, n.id)
    const ids = new Set(after.map((e) => e.id))
    const added = after.filter((e) => !before.has(e.id)).map((e) => e.id)
    const renamed = after.filter((e) => before.has(e.id) && before.get(e.id)!.title !== e.title).map((e) => e.id)
    const removed = [...before.keys()].filter((id) => !ids.has(id))
    if (added.length || removed.length || renamed.length) {
      out.push({ nodeId: n.id, added: added.slice(0, EDGE_CHANGE_MAX), removed: removed.slice(0, EDGE_CHANGE_MAX), renamed: renamed.slice(0, EDGE_CHANGE_MAX) })
      if (out.length >= EDGE_CHANGE_MAX) break
    }
  }
  return out
}

/** Records `edge.change` when the save changed any cable; never throws into the save path. */
export function produceEdgeChange(prev: Workspace | null | undefined, next: Workspace): void {
  let changes: EdgeChange[]
  try {
    changes = edgeChanges(prev, next)
  } catch (err) {
    // The save body is only checked to be an object, so a malformed node list lands here.
    log.warn('events.edge.diff_failed', 'edge diff failed; no edge.change recorded', { workspaceId: next.id, cause: err instanceof Error ? err.message : String(err) })
    return
  }
  if (changes.length === 0) return
  recordEvent({
    kind: 'edge.change',
    source: 'workspacesApi',
    actor: 'human-ui',
    subject: `workspace:${next.id}`,
    workspaceId: next.id,
    trust: 'trusted',
    payload: { changes },
  })
}
