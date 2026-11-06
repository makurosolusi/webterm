// Human-UI-only gate for route entries that read or write the user's files and board (sec-208-1).
// The outer gate (`allowed()`, index.ts) admits several credentials, node tokens included on their
// own paths; wrapped entries answer only:
//   - the signed-in webterm page (`uiOnlyDenial`, approvalAuth.ts: live `wt_ui` cookie, same-origin
//     fetch metadata, no agent credential), or
//   - a request carrying the root token header (an operator script; the outer gate already proved it).
// Agent sessions keep their own surfaces (/api/tools, /api/control/*, /api/context-link), none of
// which route through a wrapped entry. Lock: routes/route.uiOnly.policy.bun.test.ts.
import { TOKEN_HEADER, tokensMatch } from '../auth'
import { uiOnlyDenial } from '../approvalAuth'
import { firstHeader } from '../httpHeaders'
import { getTokenState } from '../tokenBootstrap'
import { json, type ApiRoute, type RouteCtx } from './route.core'

const UI_ONLY_MESSAGE = 'Files and workspaces are available to the webterm UI only.'

/** true when this request presents the root token header (tokensMatch fails closed without one). */
const hasRootToken = (c: RouteCtx): boolean => tokensMatch(getTokenState().token, firstHeader(c.req.headers[TOKEN_HEADER]))

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
