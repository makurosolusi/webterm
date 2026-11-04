// Web Push + the /m PWA reads (push/push.route.ts, push/mobileAgents.ts), lazily imported. Root
// token only (not in `isNodeTokenPath`); /api/push is UI-only on top (agent credentials get 403).
import { send, type ApiRoute } from './route.core'

export const pushRoutes: ApiRoute[] = [
  {
    name: 'push',
    match: (c) => c.path === '/api/push' || c.path.startsWith('/api/push/'),
    handle: async (c) => {
      const [{ pushRoute, PUSH_BODY_MAX_BYTES }, { productionPushDeps }, { isValidNodeToken }] = await Promise.all([
        import('../push/push.route'), import('../push/push.runtime'), import('../hooksTokens'),
      ])
      return send(c.res, await pushRoute(c.req, c.url, c.method, c.body(PUSH_BODY_MAX_BYTES), { push: await productionPushDeps(), isNodeToken: isValidNodeToken }))
    },
  },
  {
    name: 'mobile',
    match: (c) => c.path === '/api/mobile/agents',
    handle: async (c) => {
      if (c.method !== 'GET') return send(c.res, { status: 405, body: { error: 'method_not_allowed' } })
      const [{ listMobileAgents }, { db }, { sessions }] = await Promise.all([import('../push/mobileAgents'), import('../db'), import('../sessions')])
      const ledger = c.ledger()
      return send(c.res, {
        status: 200,
        body: { agents: listMobileAgents({ workspaces: () => db.list(), statusOf: (id) => sessions.statusOf(id), isLive: (id) => sessions.isLive(id), ledgerDb: () => ledger?.db ?? null }) },
      })
    },
  },
]
