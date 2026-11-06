// "Signed-in UI only, agent-credential deny": policy for surfaces only a human at the webterm UI
// may drive (/api/approvals*, token enable/rotate, files and board via route.uiOnly.ts). Runs AFTER
// the transport gate `allowed()` in index.ts. Pure: no server, no bun:sqlite (testable in node-env);
// the session store registers its verifier through `acceptUiSessions` (uiSession.ts).
import type { IncomingMessage } from 'node:http'
import { CAPABILITY_HEADER, TOKEN_HEADER, UI_SESSION_COOKIE, readCookie, sameOrigin } from './auth'
import { firstHeader } from './httpHeaders'

export const AGENT_CANNOT_APPROVE = 'agent_cannot_approve'
export const APPROVAL_BROWSER_ONLY = 'approval_browser_only'
export type UiOnlyDenial = typeof AGENT_CANNOT_APPROVE | typeof APPROVAL_BROWSER_ONLY

const uiSessionChecks = new Set<(raw: string) => boolean>()
/** Register a `wt_ui` cookie verifier (uiSession.ts in production; a fixed value in test kits). */
export function acceptUiSessions(check: (raw: string) => boolean): void {
  uiSessionChecks.add(check)
}
const signedIn = (raw: string | undefined): boolean => raw !== undefined && [...uiSessionChecks].some((check) => check(raw))

/**
 * `null` = allowed; otherwise the 403 error code.
 *
 * 1. Agent credential => deny. A capability header, or a token header that is a NODE token
 *    (agent PTYs get WEBTERM_TOKEN = their node token, sessions.ts), names the caller as an agent
 *    session. Same idea as Orca's rpc-caller-scope: the caller's credential kind decides the scope,
 *    and an agent scope never reaches a human gate.
 * 2. Browser origin required: `Sec-Fetch-Site: same-origin` AND `sameOrigin()` (nodeterm origin.ts
 *    mirror). Jupyter's XSRF/Origin check rests on the same fact: a page cannot forge fetch metadata
 *    and a plain curl does not send it.
 *
 * 3. Signed in: a live `wt_ui` session cookie. Fetch metadata alone is forgeable by any same-uid
 *    process; the HttpOnly cookie lives in a browser profile the agent sandbox cannot read
 *    (docs/decisions/ui-session-cookie.md), so it is what actually proves the human page.
 */
export function uiOnlyDenial(
  req: IncomingMessage,
  url: URL,
  isNodeToken: (token: string) => boolean
): UiOnlyDenial | null {
  const headers = req.headers ?? {}
  if ((firstHeader(headers[CAPABILITY_HEADER]) ?? '') !== '') return AGENT_CANNOT_APPROVE
  const token = firstHeader(headers[TOKEN_HEADER])?.trim()
  if (token && isNodeToken(token)) return AGENT_CANNOT_APPROVE
  if (firstHeader(headers['sec-fetch-site']) !== 'same-origin' || !sameOrigin(headers)) return APPROVAL_BROWSER_ONLY
  if (!signedIn(readCookie(firstHeader(headers.cookie), UI_SESSION_COOKIE))) return APPROVAL_BROWSER_ONLY
  return null
}
