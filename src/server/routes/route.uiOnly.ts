// Human-UI-only gate for route entries that read or write the user's files and board (sec-208-1,
// temporary mitigation). On a token-free loopback bind the outer gate (`allowed()`, index.ts)
// admits any local process, so a plain `curl` or an agent shell could list/read/write any path and
// rewrite workspaces. Wrapped entries answer only:
//   - the webterm page (`uiOnlyDenial`, approvalAuth.ts: same-origin fetch metadata, no agent
//     credential), or
//   - a request carrying the configured root token (an operator script; the outer gate already
//     proved it, and node tokens never pass the outer gate on these paths: `isNodeTokenPath`).
// Agent sessions keep their own surfaces (/api/tools, /api/control/*, /api/context-link), none of
// which route through a wrapped entry. Lock: routes/route.uiOnly.policy.bun.test.ts.
// ponytail: `Sec-Fetch-Site` can be forged by a deliberate same-uid process (see uiOnlyDenial);
// the permanent fix is a UI session secret bound to the page, as nodeterm control-confirm does.
import { TOKEN_HEADER, TOKEN_PARAM, tokensMatch } from '../auth'
import { uiOnlyDenial } from '../approvalAuth'
import { firstHeader } from '../httpHeaders'
import { getTokenState } from '../tokenBootstrap'
import { json, type ApiRoute, type RouteCtx } from './route.core'

const UI_ONLY_MESSAGE = 'Files and workspaces are available to the webterm UI only.'

/** true when a root token is configured and this request presents it. */
function hasRootToken(c: RouteCtx): boolean {
  const root = getTokenState().token
  if (root === undefined) return false
  return tokensMatch(root, firstHeader(c.req.headers[TOKEN_HEADER]) ?? c.url.searchParams.get(TOKEN_PARAM))
}

/** `route` answering 403 to anything but the webterm page or the root token; needs a `match`. */
export function uiOnly(route: ApiRoute & { match: NonNullable<ApiRoute['match']> }): ApiRoute {
  return {
    ...route,
    handle: async (c) => {
      if (!hasRootToken(c)) {
        // Lazy: hooksTokens pulls in the session layer (as workspaceCreate.route.ts does).
        const { isValidNodeToken } = await import('../hooksTokens')
        const denial = uiOnlyDenial(c.req, c.url, isValidNodeToken)
        if (denial) {
          json(c.res, 403, { error: denial, message: UI_ONLY_MESSAGE })
          return true
        }
      }
      return route.handle(c)
    },
  }
}
