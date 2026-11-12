// Claude provider (claudeProvider/claudeProvider.api.ts), lazily imported. UI-only: the handler applies
// `uiOnlyDenial`, and the path is not in `isNodeTokenPath`, so agent credentials never reach it.
import { send, type ApiRoute } from './route.core'

export const claudeProviderRoutes: ApiRoute[] = [
  {
    name: 'claude-provider-test',
    match: (c) => c.path === '/api/claude-provider/test',
    handle: async (c) => {
      const [{ streamProviderTest }, { isValidNodeToken }, { freshClaudePreflight }] = await Promise.all([
        import('../claudeProvider/claudeProvider.connectionStream'), import('../hooksTokens'), import('../centralChatHealth'),
      ])
      return streamProviderTest(c.req, c.res, c.url, { isNodeToken: isValidNodeToken, refreshCentral: () => { freshClaudePreflight() } })
    },
  },
  {
    name: 'claude-provider',
    match: (c) => c.path === '/api/claude-provider' || c.path === '/api/claude-provider/detect' || c.path === '/api/claude-provider/reset',
    handle: async (c) => {
      const [{ providerRoute }, { isValidNodeToken }, { sessions }, { db }] = await Promise.all([
        import('../claudeProvider/claudeProvider.api'), import('../hooksTokens'), import('../sessions'), import('../db'),
      ])
      return send(c.res, await providerRoute(c.req, c.url, {
        isNodeToken: isValidNodeToken,
        sessionsBefore: (t) => sessions.claudeSessionsStartedBefore(t),
        defaults: { get: () => db.getSettings().defaultClaudeProfileId, set: (id) => { db.saveSettings({ defaultClaudeProfileId: id }) } },
      }))
    },
  },
]
