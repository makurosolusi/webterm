// Central agent surfaces: chat, CA2 control panel, and the P3/P4 extended mount
// (/api/central/*, orchestrator run/bootstrap/assign, memory export/rebuild).
import { centralChatRoute } from '../centralChatApi'
import { ca2Route } from '../central/ca2Routes'
import { extendedApiRoute } from '../extendedApi'
import type { ApiRoute } from './route.core'

export const centralRoutes: ApiRoute[] = [
  // Exact paths only; flags inside. Before the read-only projections and the 404 fallback so its
  // SSE response can stay open; portfolio routes are untouched.
  { name: 'central-chat', handle: (c) => centralChatRoute(c.req, c.res, c.url, { ledger: c.ledger() }) },
  // Central Agent v2 control panel; answers only while CA2 is armed (flags), otherwise falls through.
  { name: 'ca2', handle: (c) => ca2Route(c.req, c.res, c.url) },
  { name: 'extended', handle: (c) => extendedApiRoute(c.req, c.res, c.url, c.ledger()) },
]
