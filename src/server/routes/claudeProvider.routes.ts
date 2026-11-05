// Claude provider (claudeProvider/claudeProvider.api.ts), lazily imported. UI-only: the handler applies
// `uiOnlyDenial`, and the path is not in `isNodeTokenPath`, so agent credentials never reach it.
import { send, type ApiRoute } from './route.core'

export const claudeProviderRoutes: ApiRoute[] = [
  {
    name: 'claude-provider',
    match: (c) => c.path === '/api/claude-provider' || c.path === '/api/claude-provider/test' || c.path === '/api/claude-provider/detect',
    handle: async (c) => {
      const [{ providerRoute }, { isValidNodeToken }, { sessions }, { freshClaudePreflight }] = await Promise.all([
        import('../claudeProvider/claudeProvider.api'), import('../hooksTokens'), import('../sessions'), import('../centralChatHealth'),
      ])
      return send(c.res, await providerRoute(c.req, c.url, {
        isNodeToken: isValidNodeToken,
        sessionsBefore: (t) => sessions.claudeSessionsStartedBefore(t),
        loginReady: async () => {
          const r = await freshClaudePreflight()()
          return r.ok ? { ok: true } : { ok: false, hint: r.hint }
        },
      }))
    },
  },
]
