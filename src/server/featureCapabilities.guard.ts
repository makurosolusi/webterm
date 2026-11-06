// Invisible guard for settings/capability mutations: the user sees no token or dialog, yet the server
// still refuses every other process (node tokens, capabilities, foreign pages).
// Two credentials, both root-equivalent: the root token header (an operator script), or the signed-in
// webterm page's `wt_ui` cookie (minted only for the root token or a one-time open code, auth.routes.ts).
// The cookie is a credential of its own, so no loopback/forwarded peer check: a remote web channel or a
// reverse proxy is the normal case, as for the root header (docs/decisions/ui-session-cookie.md).
// A denial is always a generic 403 `forbidden`; the client turns it into a cause + way out
// (`CAPABILITY_TEXT.forbidden` in capabilitiesLabels.ts).
import type { IncomingMessage } from 'node:http'
import { hasUiSession } from './approvalAuth'
import { CAPABILITY_HEADER, TOKEN_HEADER, sameOrigin, tokensMatch } from './auth'
import { firstHeader } from './httpHeaders'
import { getTokenState } from './tokenBootstrap'

/** Denial reason; generic, never carries header contents. */
export type GuardReason = 'origin' | 'token_kind' | 'session'
/** `token` = valid root token header; `ui` = the signed-in webterm page (live cookie, same-origin). */
export type GuardResult = { ok: true; via: 'token' | 'ui' } | { ok: false; reason: GuardReason }

/** Peers seen on the socket as loopback; proxy headers are not trusted (forgeable). Audit only. */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Request peer for the audit row: loopback or remote (from the socket). */
export function peerOf(req: IncomingMessage): 'loopback' | 'remote' {
  const addr = req.socket?.remoteAddress
  return addr !== undefined && LOOPBACK_PEERS.has(addr) ? 'loopback' : 'remote'
}

/** Origin MUST be present and same-origin: browsers always send it on PUT/POST; a script without one is refused. */
const originPresentAndSame = (req: IncomingMessage): boolean => {
  const origin = firstHeader(req.headers?.origin)
  return typeof origin === 'string' && origin !== '' && sameOrigin(req.headers)
}

/** `write` = a mutation (Origin required); `read` = an owner-only read, where browsers send no Origin on a same-origin GET. */
export type GuardPurpose = 'read' | 'write'

/**
 * May this request proceed? (A) a matching root token header and no capability; (B) no credential
 * header at all, a live `wt_ui` cookie and, for a write, a present same-origin Origin. Any other token
 * header (a node token, a wrong one) or a capability is `token_kind`, whatever cookie rides along.
 */
export function settingsGuard(
  req: IncomingMessage,
  rootToken: string | undefined = getTokenState().token,
  purpose: GuardPurpose = 'write'
): GuardResult {
  const presented = firstHeader(req.headers?.[TOKEN_HEADER]) || undefined
  if (firstHeader(req.headers?.[CAPABILITY_HEADER])) return { ok: false, reason: 'token_kind' }
  if (presented !== undefined) {
    return tokensMatch(rootToken, presented) ? { ok: true, via: 'token' } : { ok: false, reason: 'token_kind' }
  }
  if (purpose === 'write' && !originPresentAndSame(req)) return { ok: false, reason: 'origin' }
  if (!hasUiSession(req.headers)) return { ok: false, reason: 'session' }
  return { ok: true, via: 'ui' }
}
