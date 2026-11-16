// How a Claude failure is classified, as one pure vocabulary shared by the chat runtime (claudeFailure.ts) and the work
// watcher (StopFailure hooks): the class decides who may fix it (a later retry, or a human), never the model's mood.

/** `network` our link to the API is down; `rate_limited` / `overloaded` / `server` the API said wait; `auth` / `permanent` need a human. */
export type FailureKind = 'network' | 'rate_limited' | 'overloaded' | 'server' | 'auth' | 'permanent' | 'unknown'

/** Classes a later retry can fix without anyone deciding anything; the rest keep the human path. */
export const TRANSIENT_KINDS: readonly FailureKind[] = ['network', 'rate_limited', 'overloaded', 'server']

export const isTransientKind = (kind: FailureKind | undefined): boolean => kind !== undefined && TRANSIENT_KINDS.includes(kind)

// Order matters (first match wins): money and credentials are never retried, even when the message also says 429 or "limit".
const PERMANENT = /credit balance|spend(?:ing)? (?:cap|limit)|monthly (?:spend|usage) limit|billing|insufficient (?:credit|funds|quota)|payment required|\b402\b/i
const AUTH = /not logged in|please run \/login|invalid api key|authentication[_ ]failed|oauth[a-z ]* (?:token )?(?:has )?(?:expired|not allowed)|account[_ ]on[_ ]hold|\b40[13]\b|unauthori[sz]ed|forbidden/i
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|unable to connect|can'?t reach the api|no internet|connection dropped|request timed out|fetch failed|network/i
const RATE_LIMITED = /rate.?limit|\b429\b|session limit|too many requests|request rejected/i
const OVERLOADED = /overloaded|\b529\b/i
const SERVER = /\b5\d\d\b|server[_ ]error|internal error/i

/** Classifies free text (CLI result, stderr, hook details). */
export function failureKindOfText(text: string): FailureKind {
  if (PERMANENT.test(text)) return 'permanent'
  if (AUTH.test(text)) return 'auth'
  if (NETWORK.test(text)) return 'network'
  if (RATE_LIMITED.test(text)) return 'rate_limited'
  if (OVERLOADED.test(text)) return 'overloaded'
  if (SERVER.test(text)) return 'server'
  return 'unknown'
}

/** `StopFailure.error` / assistant `error` values documented by Claude Code. */
const STOP_FAILURE: Readonly<Record<string, FailureKind>> = {
  rate_limit: 'rate_limited', overloaded: 'overloaded', server_error: 'server',
  authentication_failed: 'auth', oauth_org_not_allowed: 'auth', account_on_hold: 'auth', cloud_credential_error: 'auth',
  billing_error: 'permanent', invalid_request: 'permanent', model_not_found: 'permanent', max_output_tokens: 'permanent',
  unknown: 'unknown',
}

/** Class of a `StopFailure.error` code; a vague code (`unknown`, `server_error`) is refined by its details when they show a dead link. */
export function failureKindOfStop(error: string, details?: string): FailureKind {
  const kind = STOP_FAILURE[error] ?? 'unknown'
  if ((kind === 'unknown' || kind === 'server') && details && failureKindOfText(details) === 'network') return 'network'
  return kind
}
