// Deterministic state header (RND/23 §4.4): counts and ids that need attention, <= 2000 chars,
// JSON keys in fixed order, no clock. Details are read on demand through tools.
import type { Database } from 'bun:sqlite'
import { portfolio } from '../centralProjection'
import { scopeFromConversationId } from '../conversationModel'

/** Hard cap of the header text. */
export const HEADER_MAX_CHARS = 2000
const PROJECT_FETCH_LIMIT = 50

/** Renders the header for a conversation scope; shrinks the project list until it fits the cap. */
export function buildStateHeader(db: Database, conversationId: string): string {
  const scope = scopeFromConversationId(conversationId)
  const page = portfolio(db, scope.kind === 'project' ? { projectId: scope.projectId, limit: 1 } : { limit: PROJECT_FETCH_LIMIT })
  const projects = page.items.map((p) => ({ approvals: p.pendingApprovals, id: p.id, name: p.name.slice(0, 40), status: p.status }))
  const render = (count: number): string => `State: ${JSON.stringify({
    projectTotal: page.total,
    projects: projects.slice(0, count),
    scope: scope.kind === 'project' ? scope.projectId : 'global',
  })}`
  let count = projects.length
  while (count > 0 && render(count).length > HEADER_MAX_CHARS) count -= 1
  return render(count)
}
