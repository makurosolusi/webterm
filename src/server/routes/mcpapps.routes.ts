// MCP Apps (`ui://` views in an App node, mcpapps/mcpApp.route.ts), lazily imported. Mounted before
// the control family: the agent publish path `/api/control/mcpapps` nests inside it.
import { send, type ApiRoute } from './route.core'

export const mcpAppsRoutes: ApiRoute[] = [
  {
    name: 'mcpapps',
    match: (c) => c.path === '/api/control/mcpapps' || c.path === '/api/mcpapps' || c.path.startsWith('/api/mcpapps/'),
    handle: async (c) => {
      const { mcpAppsRoute, processMcpAppsDeps, MCP_APPS_BODY_MAX_BYTES } = await import('../mcpapps/mcpApp.route')
      return send(c.res, await mcpAppsRoute(c.req, c.url, c.body(MCP_APPS_BODY_MAX_BYTES), await processMcpAppsDeps()))
    },
  },
]
