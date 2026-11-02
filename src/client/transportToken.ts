// Transport-token constants and side-effect-free helpers shared by api.ts, inboxTransport.ts and
// chat/chatTransport.ts. No module-level work here on purpose: api.ts rewrites the page URL at
// import time, and the other transports must stay importable by tests that fake `location`.

/** Must match TOKEN_PARAM in src/server/auth.ts. */
export const TOKEN_PARAM = 'token'
export const TOKEN_KEY = 'webterm.token'

/**
 * Read-only token lookup: the one-time URL parameter wins, sessionStorage is the fallback.
 * Unlike api.ts's startup read it never stores the token or edits the address bar.
 */
export function peekToken(): string {
  try {
    if (typeof location !== 'undefined' && typeof location.href === 'string') {
      const fromUrl = new URL(location.href).searchParams.get(TOKEN_PARAM)
      if (fromUrl !== null && fromUrl !== '') return fromUrl
    }
  } catch {
    // Malformed location in an exotic embedding: fall through to sessionStorage.
  }
  try {
    return typeof sessionStorage === 'undefined' ? '' : sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Private mode / blocked site data makes the access itself throw. Token-free loopback still
    // works; a token-protected server answers 401 and the caller surfaces that.
    return ''
  }
}

/** True for a fetch/AbortController abort. Aborts are cancellations, not failures to display. */
export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}
