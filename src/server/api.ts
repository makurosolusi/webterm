import type { IncomingMessage, ServerResponse } from 'node:http'
import { startRequestLog } from './logs'
import { json, routeCtx, type ApiRoute } from './routes/route.core'
import { briefRoutes, logEventRoutes, outboxRoutes } from './routes/events.routes'
import { workspaceRoutes } from './routes/workspaces.routes'
import { browserRoutes } from './routes/browser.routes'
import { settingsRoutes } from './routes/settings.routes'
import { fsRoutes } from './routes/fs.routes'
import { gitRoutes, worktreeRoutes } from './routes/git.routes'
import { controlRoutes } from './routes/control.routes'
import { miscRoutes } from './routes/misc.routes'
import { centralRoutes } from './routes/central.routes'
import { policyRoutes } from './routes/policy.routes'
import { policySimRoutes } from './routes/policySim.routes'
import { memory2Routes } from './routes/memory2.routes'
import { blackboardRoutes } from './routes/blackboard.routes'
import { ledgerRoutes } from './routes/ledger.routes'
import { routinesRoutes } from './routes/routines.routes'
import { sensorRoutes } from './routes/sensors.routes'
import { costRoutes } from './routes/cost.routes'
import { dagRoutes } from './routes/dag.routes'
import { knowledge2Routes } from './routes/knowledge2.routes'
import { handoffRoutes } from './routes/handoff.routes'
import { pushRoutes } from './routes/push.routes'
import { claudeProviderRoutes } from './routes/claudeProvider.routes'
import { proxyInfoRoutes } from './routes/proxy.routes'
import { bakeoffRoutes } from './routes/bakeoff.routes'
import { evalCasesRoutes } from './routes/evalcases.routes'
import { mcpAppsRoutes } from './routes/mcpapps.routes'

export { applyPtyOptions } from './routes/settings.routes'

/**
 * Every /api route, tried in this order; the first entry that answers wins (Hono/itty-router style
 * ordered table). New routes go into their own domain file under ./routes, not here. The group
 * order is load-bearing (see routes/apiRoutes.bun.test.ts): e.g. mcp before the control family it
 * nests in, UI-only policy/secrets/procedural before the generic memory writes.
 */
export const API_ROUTES: readonly ApiRoute[] = [
  ...logEventRoutes,
  ...workspaceRoutes,
  ...browserRoutes,
  ...settingsRoutes,
  ...fsRoutes,
  ...gitRoutes,
  ...briefRoutes,
  ...handoffRoutes,
  ...worktreeRoutes,
  ...sensorRoutes,
  ...outboxRoutes,
  ...mcpAppsRoutes,
  ...controlRoutes,
  ...miscRoutes,
  ...centralRoutes,
  ...policyRoutes,
  ...policySimRoutes,
  ...memory2Routes,
  ...blackboardRoutes,
  ...routinesRoutes,
  ...ledgerRoutes,
  ...costRoutes,
  ...dagRoutes,
  ...knowledge2Routes,
  ...pushRoutes,
  ...claudeProviderRoutes,
  ...proxyInfoRoutes,
  ...bakeoffRoutes,
  ...evalCasesRoutes,
]

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = routeCtx(req, res, route)
  for (const r of API_ROUTES) {
    if (r.match && !r.match(ctx)) continue
    if (await r.handle(ctx)) return
  }
  json(res, 404, { error: 'unknown route' })
}

// Returns true when it has taken over the response; false lets the caller fall
// through to Vite/static. The response is finished asynchronously.
//
// Every route rides the one net below. A dropped rejection left the socket open with no status and
// no body until the client timed out, so the net lives here, not per route family: the next route
// that throws is covered without touching it.
export function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url || !req.url.startsWith('/api/')) return false
  const requestLog = startRequestLog(req, res)
  route(req, res).catch((err: unknown) => {
    // Method + pathname ONLY (inside startRequestLog): the query string carries the auth token
    // (TOKEN_PARAM), and the error itself can quote absolute paths or request bodies — so it goes
    // to the log, never to the body the client reads.
    requestLog.fail(err)
    if (res.writableEnded) return
    // A partially sent response (context-link flushes headers before its body) cannot take a
    // status any more — setting one throws again. Just close what the client already has.
    if (res.headersSent) { res.end(); return }
    json(res, 500, { error: 'internal error' })
  })
  return true
}
