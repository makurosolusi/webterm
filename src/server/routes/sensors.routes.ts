// Workspace sensors: listening ports, tsc/eslint problems, runnable tasks. GETs are read-only for
// any authenticated caller; POSTs (problems run/stop/fix, tasks/run) are human-UI only (uiOnlyDenial
// inside each route). Lazy imports: the families pull ../db and ../sessions only when hit.
import { WORKSPACES_BODY_MAX_BYTES } from '../cappedRequestBody'
import { send, type ApiRoute } from './route.core'

export const sensorRoutes: ApiRoute[] = [
  { name: 'ports', handle: async (c) => send(c.res, await (await import('../ports/ports.runtime')).portsRoute(c.path, c.method, c.url.searchParams)) },
  { name: 'problems', handle: async (c) => send(c.res, await (await import('../problems/problems.route')).problemsRoute(c.req, c.url, c.body(WORKSPACES_BODY_MAX_BYTES))) },
  { name: 'tasks', handle: async (c) => send(c.res, await (await import('../tasks/tasks.route')).tasksRoute(c.req, c.url, c.body(WORKSPACES_BODY_MAX_BYTES))) },
]
