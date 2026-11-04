// Ledger-backed memory writes and read-only projections (inbox/memory/orchestrator). Ledger off
// answers 503 `ledger_off` instead of an empty list; null from a family = keep falling through.
import { inboxRoute } from '../inboxApi'
import { memoryRoute } from '../memoryApi'
import { memoryWriteRoute, MEMORY_WRITE_BODY_MAX_BYTES } from '../memoryWriteApi'
import { orchestratorRoute } from '../orchestratorApi'
import { send, type ApiRoute } from './route.core'

export const ledgerRoutes: ApiRoute[] = [
  // Memory writes (claim/promote). Body capped at 64 KiB and read lazily, so the read-only GETs
  // below never touch the stream. Authority is derived here as root human, never from the payload.
  { name: 'memory-write', handle: async (c) => send(c.res, await memoryWriteRoute(c.path, c.method, c.body(MEMORY_WRITE_BODY_MAX_BYTES), c.ledger())) },
  { name: 'inbox', handle: (c) => send(c.res, inboxRoute(c.path, c.method, c.url.searchParams, c.ledger())) },
  { name: 'memory', handle: (c) => send(c.res, memoryRoute(c.path, c.method, c.url.searchParams, c.ledger())) },
  { name: 'orchestrator', handle: (c) => send(c.res, orchestratorRoute(c.path, c.method, c.url.searchParams, c.ledger())) },
]
