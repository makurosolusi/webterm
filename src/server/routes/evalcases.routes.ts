// Eval cases from user rejections (evalcases/evalCase.route.ts), lazily imported. UI-only: the paths
// are not in `isNodeTokenPath`, so agent credentials never reach them.
import { send, type ApiRoute } from './route.core'

export const evalCasesRoutes: ApiRoute[] = [
  {
    name: 'evalcases',
    match: (c) => c.path === '/api/evalcases' || c.path.startsWith('/api/evalcases/'),
    handle: async (c) => {
      const { evalCasesRoute, EVAL_CASES_BODY_MAX_BYTES } = await import('../evalcases/evalCase.route')
      return send(c.res, await evalCasesRoute(c.url, c.method, c.body(EVAL_CASES_BODY_MAX_BYTES)))
    },
  },
]
