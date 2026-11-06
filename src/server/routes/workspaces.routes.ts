// Workspaces (/api/workspaces[/:id], /api/active) and Agent History.
import { db } from '../db'
import { workspacesRoute } from '../workspacesApi'
import { sessionHistoryDeps, sessionHistoryRoute } from '../sessionHistory.route'
import { WORKSPACES_BODY_MAX_BYTES } from '../cappedRequestBody'
import { send, type ApiRoute } from './route.core'
import { uiOnly } from './route.uiOnly'

const WORKSPACES_PATH = '/api/workspaces'
const ACTIVE_PATH = '/api/active'

export const workspaceRoutes: ApiRoute[] = [
  // null for anything else, including a method this family does not answer (-> 404 at the end).
  // A 204 answers WITHOUT a `body` key, and `json` keeps those body-less. Body capped at 1 MiB and
  // read only for POST/PUT; the fs/git readers further down stay uncapped (file contents may be big).
  // UI-only (route.uiOnly.ts): no plain curl / agent shell rewrites or deletes the board.
  uiOnly({
    name: 'workspaces',
    match: (c) => c.path === WORKSPACES_PATH || c.path.startsWith(`${WORKSPACES_PATH}/`) || c.path === ACTIVE_PATH,
    handle: async (c) => send(c.res, await workspacesRoute(db, c.path, c.method, c.body(WORKSPACES_BODY_MAX_BYTES))),
  }),
  // Paged transcript index + history of closed nodes (sessionHistory.route.ts).
  {
    name: 'session-history',
    match: (c) => c.path.startsWith('/api/session-history') || c.path.startsWith('/api/closed-history'),
    handle: async (c) => send(c.res, await sessionHistoryRoute(c.path, c.method, c.url.searchParams, c.body(WORKSPACES_BODY_MAX_BYTES), await sessionHistoryDeps())),
  },
]
