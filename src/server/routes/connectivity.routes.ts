// GET /api/connectivity: the detector's state plus the latest episodes. Behind the same /api gate as every
// other route; 503 while the detector is not running (no ledger).
import { json, type ApiRoute } from './route.core'

export const CONNECTIVITY_EPISODES_LIMIT = 20

export const connectivityRoutes: ApiRoute[] = [
  {
    name: 'connectivity',
    match: (c) => c.path === '/api/connectivity' && c.method === 'GET',
    handle: async (c) => {
      const { activeConnectivity } = await import('../connectivity/connectivity.runtime')
      const svc = activeConnectivity()
      if (!svc) json(c.res, 503, { error: 'connectivity_unavailable' })
      else json(c.res, 200, { ...svc.state(), episodes: svc.episodes(CONNECTIVITY_EPISODES_LIMIT) })
      return true
    },
  },
]
