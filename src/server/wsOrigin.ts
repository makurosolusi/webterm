// Extra gate for the human channels — `/ws` (ends in a PTY) and `/ws/browser` (the user's logged-in
// browser) — on top of `allowed()` in index.ts. Agents reach the browser via `/api/control/browser/*`.
//
// `allowed()` already demanded a credential. An operator script holding the root token header passes
// as is. Anything else got in on the `wt_ui` cookie, which only the web UI holds: that caller must
// also send a same-origin `Origin`, (session cookie +
// `sameOriginRequest`) does. Browsers always send Origin on a WebSocket handshake (RFC 6455 §4.1).
import { TOKEN_HEADER, sameOrigin, tokensMatch } from './auth'
import { type HeaderBag, firstHeader } from './httpHeaders'

/** Reason string sent in the 403 body when a human-channel upgrade is refused for lacking a browser Origin. */
export const WS_ORIGIN_REQUIRED = 'origin_required'

/** May this human-channel upgrade (`/ws`, `/ws/browser`) proceed? Root token header, or a PRESENT same-origin Origin. */
export function humanUpgradeOriginOk(headers: HeaderBag, rootToken: string | undefined): boolean {
  if (tokensMatch(rootToken, firstHeader(headers[TOKEN_HEADER]))) return true
  const origin = firstHeader(headers['origin'])
  return typeof origin === 'string' && origin !== '' && sameOrigin(headers)
}
