// Cost panel API (cost/cost.route.ts), lazily imported. The first request also starts usage
// capture, so cost works without a boot step; `startCostCapture()` at boot just starts it earlier.
import { send, type ApiRoute } from './route.core'

export const costRoutes: ApiRoute[] = [
  {
    name: 'cost',
    match: (c) => c.path === '/api/cost' || c.path.startsWith('/api/cost/'),
    handle: async (c) => {
      const [{ costRoute, COST_BODY_MAX_BYTES }, runtime, { workspaceLabels }, { db }] = await Promise.all([
        import('../cost/cost.route'), import('../cost/costRuntime'), import('../brief/brief.route'), import('../db'),
      ])
      await runtime.startCostCapture()
      const labels = workspaceLabels(() => db.list())
      return send(c.res, await costRoute(c.path, c.method, c.url.searchParams, c.body(COST_BODY_MAX_BYTES), {
        db: c.ledger()?.db ?? null,
        sync: runtime.syncCentral,
        label: (kind, id) => (kind === 'workspace' ? labels.workspaceLabel(id) : labels.nodeLabel(id)),
      }))
    },
  },
]
