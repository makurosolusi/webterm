// Where a check-in turn lands: back where the work was asked for, never in a conversation the reason has nothing to do with.
import type { Database } from 'bun:sqlite'
import { GLOBAL_CONVERSATION_ID, PROJECT_CONVERSATION_PREFIX } from '../conversationModel'
import { getConversation } from '../conversationStore'

/** What routing needs of a queued reason. */
export interface Routable { id: string; projectId: string | null; conversationId: string | null }
/** A batch slice for one conversation; `orphans` are the reasons whose origin is gone (they get a notice there). */
export interface RouteGroup<R extends Routable> { conversationId: string; reasons: R[]; orphans: R[] }

const alive = (db: Database, id: string): boolean => id === GLOBAL_CONVERSATION_ID || getConversation(db, id) !== null

/** Project chat if it exists, else global; also where a duty/project notice goes. */
export function projectTarget(db: Database, projectId: string | null): string {
  if (projectId === null) return GLOBAL_CONVERSATION_ID
  const id = `${PROJECT_CONVERSATION_PREFIX}${projectId}`
  return getConversation(db, id) ? id : GLOBAL_CONVERSATION_ID
}

/** Origin conversation (if it still exists), else project chat, else global. */
export function routeOf(db: Database, r: Routable): { conversationId: string; orphan: boolean } {
  if (r.conversationId !== null && alive(db, r.conversationId)) return { conversationId: r.conversationId, orphan: false }
  return { conversationId: projectTarget(db, r.projectId), orphan: r.conversationId !== null }
}

/** Splits a batch by destination, keeping the batch order of both groups and reasons. */
export function groupByTarget<R extends Routable>(db: Database, batch: readonly R[]): RouteGroup<R>[] {
  const groups = new Map<string, RouteGroup<R>>()
  for (const r of batch) {
    const { conversationId, orphan } = routeOf(db, r)
    const g = groups.get(conversationId) ?? { conversationId, reasons: [], orphans: [] }
    g.reasons.push(r)
    if (orphan) g.orphans.push(r)
    groups.set(conversationId, g)
  }
  return [...groups.values()]
}
