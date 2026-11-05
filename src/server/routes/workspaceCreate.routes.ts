// "Clone repository" / "New project" (workspaceCreate/), lazily imported; human-UI only.
import type { ApiRoute } from './route.core'

export const workspaceCreateRoutes: ApiRoute[] = [
  {
    name: 'workspace-create',
    match: (c) => c.path === '/api/workspace-create' || c.path.startsWith('/api/workspace-create/'),
    handle: async (c) => {
      const { workspaceCreateRoute, WORKSPACE_CREATE_BODY_MAX_BYTES } = await import('../workspaceCreate/workspaceCreate.route')
      return workspaceCreateRoute(c.req, c.res, c.url, c.body(WORKSPACE_CREATE_BODY_MAX_BYTES))
    },
  },
]
