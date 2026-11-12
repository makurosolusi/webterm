// Observability: request log, Senses events, activity timeline, morning brief, agent outbox.
import { logsRoute } from '../logs'
import { eventsRoute } from '../events/eventsApi'
import { timelineRoute } from '../events/timelineApi'
import { outboxRoute } from '../outbox/outbox.route'
import { nodeStatusRoute } from '../nodeStatus.route'
import { WORKSPACES_BODY_MAX_BYTES } from '../cappedRequestBody'
import { send, type ApiRoute } from './route.core'

/** Mounted first: same /api gate as settings (applied in index.ts), own body/SSE handling. */
export const logEventRoutes: ApiRoute[] = [
  { name: 'logs', handle: (c) => logsRoute(c.req, c.res, c.url, c.method) },
  // Senses log SSE + head hash (root-only: not in isNodeTokenPath)
  { name: 'events', handle: (c) => eventsRoute(c.req, c.res, c.url, c.method) },
  // Activity timeline older-history pages (root-only too)
  { name: 'timeline', handle: (c) => timelineRoute(c.req, c.res, c.url, c.method) },
]

/** Morning brief card (brief/brief.route.ts), lazily imported. */
export const briefRoutes: ApiRoute[] = [
  { name: 'brief', handle: async (c) => send(c.res, await (await import('../brief/brief.route')).briefRoute(c.path, c.method)) },
]

/** Agent outbox (outbox/outbox.route.ts) and the node status bar facts that read it (nodeStatus.route.ts). */
export const outboxRoutes: ApiRoute[] = [
  { name: 'outbox', handle: async (c) => send(c.res, await outboxRoute(c.path, c.method, c.url.searchParams, c.body(WORKSPACES_BODY_MAX_BYTES))) },
  { name: 'node-status', handle: async (c) => send(c.res, await nodeStatusRoute(c.path, c.method, c.url.searchParams, {
    sessions: async () => (await import('../sessions')).sessions, db: () => c.ledger()?.db ?? null,
  })) },
]
