// Extra gate for the human channels — `/ws` (ends in a PTY) and `/ws/browser` (the user's logged-in
// browser) — on top of `allowed()` in index.ts. Agents reach the browser via `/api/control/browser/*`.
//
// `sameOrigin()` lets an ABSENT Origin through (non-browser client). That is fine when a credential
// is checked as well — nodeterm (`ws.ts` `upgradeAllowed`: session cookie + `sameOriginRequest`)
// and Jupyter (`check_origin` + mandatory token) both pair it with one. On a token-free loopback
// bind webterm has no credential, so "no Origin" meant any local process (curl, an agent shell)
// could open a fresh shell. Here the browser's Origin is the only proof the caller is the web UI:
// browsers always send it on a WebSocket handshake (RFC 6455 §4.1), plain curl/`ws` do not.
import { sameOrigin } from './auth'
import { type HeaderBag, firstHeader } from './httpHeaders'

/** Reason string sent in the 403 body when a human-channel upgrade is refused for lacking a browser Origin. */
export const WS_ORIGIN_REQUIRED = 'origin_required'

/**
 * May this human-channel upgrade (`/ws`, `/ws/browser`) proceed? With a root token in force the token (already verified by
 * `allowed()`) is the credential, so behaviour is unchanged. Without one, a same-origin `Origin`
 * header must be PRESENT. Accepted risk (same as docs/decisions/approval-ui-origin.md): a local
 * process that deliberately forges `Origin` still passes; the full close is the root token.
 */
export function humanUpgradeOriginOk(headers: HeaderBag, rootTokenActive: boolean): boolean {
  if (rootTokenActive) return true
  const origin = firstHeader(headers['origin'])
  return typeof origin === 'string' && origin !== '' && sameOrigin(headers)
}
