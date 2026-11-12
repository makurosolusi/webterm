// Claude launch profiles Test + effective launch (claudeLauncher/claudeLauncher.api.ts), lazily imported. UI-only.
import { send, type ApiRoute } from './route.core'

export const claudeLauncherRoutes: ApiRoute[] = [
  {
    name: 'claude-launch',
    match: (c) => c.path === '/api/claude-launch/test' || c.path === '/api/claude-launch/effective',
    handle: async (c) => {
      const [{ claudeLaunchRoute }, { isValidNodeToken }, { freshClaudePreflight }] = await Promise.all([
        import('../claudeLauncher/claudeLauncher.api'), import('../hooksTokens'), import('../centralChatHealth'),
      ])
      return send(c.res, await claudeLaunchRoute(c.req, c.url, { isNodeToken: isValidNodeToken, refreshCentral: () => { freshClaudePreflight() } }))
    },
  },
]
