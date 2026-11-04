// Handoff cards + "Continue from yesterday" (handoff/handoff.route.ts), lazily imported. UI-only: the
// paths are not in `isNodeTokenPath`, so agent credentials never reach them.
import { send, type ApiRoute } from './route.core'

export const handoffRoutes: ApiRoute[] = [
  {
    name: 'handoff',
    match: (c) => c.path === '/api/handoff' || c.path.startsWith('/api/handoff/'),
    handle: async (c) => {
      const { handoffRoute, HANDOFF_BODY_MAX_BYTES } = await import('../handoff/handoff.route')
      return send(c.res, await handoffRoute(c.path, c.method, c.body(HANDOFF_BODY_MAX_BYTES)))
    },
  },
]
