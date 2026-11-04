// "UI-origin approval, agent-credential deny": policy for surfaces only a human at the webterm UI
// may drive (/api/approvals*, token enable/rotate). Runs AFTER the transport gate `allowed()` in
// index.ts, so the root token (when enabled) has already been checked there. Pure: no server, no
// bun:sqlite, so it is testable in node-env.
import type { IncomingMessage } from 'node:http'
import { CAPABILITY_HEADER, TOKEN_HEADER, TOKEN_PARAM, sameOrigin } from './auth'
import { firstHeader } from './httpHeaders'

export const AGENT_CANNOT_APPROVE = 'agent_cannot_approve'
export const APPROVAL_BROWSER_ONLY = 'approval_browser_only'
export type UiOnlyDenial = typeof AGENT_CANNOT_APPROVE | typeof APPROVAL_BROWSER_ONLY

/**
 * `null` = allowed; otherwise the 403 error code.
 *
 * 1. Agent credential => deny. A capability header, or a transport token that is a NODE token
 *    (agent PTYs get WEBTERM_TOKEN = their node token, sessions.ts), names the caller as an agent
 *    session. Same idea as Orca's rpc-caller-scope: the caller's credential kind decides the scope,
 *    and an agent scope never reaches a human gate.
 * 2. Browser origin required: `Sec-Fetch-Site: same-origin` AND `sameOrigin()` (nodeterm origin.ts
 *    mirror). Jupyter's XSRF/Origin check rests on the same fact: a page cannot forge fetch metadata
 *    and a plain curl does not send it.
 *
 * ponytail: `Sec-Fetch-Site` is a forbidden header only for browsers; a same-uid process that
 * deliberately sets it (and omits its node token) still passes. This stops agents that use their
 * issued credentials or a plain curl; a hostile local process needs the root token to be enabled
 * (outer gate) or a confirm step bound to the UI session, nodeterm control-confirm style.
 */
export function uiOnlyDenial(
  req: IncomingMessage,
  url: URL,
  isNodeToken: (token: string) => boolean
): UiOnlyDenial | null {
  const headers = req.headers ?? {}
  if ((firstHeader(headers[CAPABILITY_HEADER]) ?? '') !== '') return AGENT_CANNOT_APPROVE
  const tokens = [firstHeader(headers[TOKEN_HEADER]), url.searchParams.get(TOKEN_PARAM)]
  if (tokens.some((t) => typeof t === 'string' && t.trim() !== '' && isNodeToken(t.trim()))) return AGENT_CANNOT_APPROVE
  if (firstHeader(headers['sec-fetch-site']) !== 'same-origin' || !sameOrigin(headers)) return APPROVAL_BROWSER_ONLY
  return null
}
