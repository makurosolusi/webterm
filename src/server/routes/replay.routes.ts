// Correlated session replay (F6): `/api/replay*`, lazily imported. UI-only: the paths are not in
// `isNodeTokenPath`, so agent credentials never reach them (they read every agent's transcript).
import { send, type ApiRoute } from './route.core'

export const replayRoutes: ApiRoute[] = [
  {
    name: 'replay',
    match: (c) => c.path === '/api/replay' || c.path.startsWith('/api/replay/'),
    handle: async (c) => {
      const { replayRoute, processReplayDeps } = await import('../replay/replay.route')
      return send(c.res, await replayRoute(c.path, c.method, c.url.searchParams, processReplayDeps))
    },
  },
]
