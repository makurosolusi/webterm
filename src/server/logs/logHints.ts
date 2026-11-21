// Classification of browser-page failures and the plain-language hint for each. One table, so "why did this
// video fail" is answered from one place (`logs.summary`) and a new failure shape is one more row here.
import { stripUrlQuery } from './logSanitize'

export type PageFailureKind = 'net' | 'console' | 'exception' | 'security'

export interface PageFailure {
  kind: PageFailureKind
  /** `ERR_*` code, `http_<status>`, `security`, `exception` or `console_error`/`console_warn`. */
  category: string
  /** Host of the failing URL; empty when the page gave none. */
  host: string
  status?: number
  /** Path of the failing URL (no query), clipped. */
  path: string
  /** Digit-normalised message prefix, only for console/exception/security (their text is the identity). */
  sig: string
}

export interface PageEntryLike { level: string; source: string; text: string; url?: string }

const MAX_PATH = 120
const SIG_CHARS = 60

function hostPath(url: string | undefined): { host: string; path: string } {
  if (!url) return { host: '', path: '' }
  try {
    const u = new URL(stripUrlQuery(url))
    return { host: u.host.toLowerCase(), path: u.pathname.slice(0, MAX_PATH) }
  } catch {
    return { host: '', path: '' }
  }
}

/** What kind of page problem a console/Log entry is; null when it is not worth a server log line (info/verbose, prompt, system). */
export function classifyPageEntry(e: PageEntryLike): PageFailure | null {
  if (e.level !== 'error' && e.level !== 'warning') return null
  const { host, path } = hostPath(e.url)
  const sig = e.text.slice(0, SIG_CHARS).replace(/\d+/g, '#')
  if (e.source === 'network') {
    const errCode = /net::(ERR_[A-Z0-9_]+)/.exec(e.text)?.[1]
    const status = Number(/status of (\d{3})/.exec(e.text)?.[1]) || undefined
    return { kind: 'net', category: errCode ?? (status ? `http_${status}` : 'network'), host, ...(status ? { status } : {}), path, sig: '' }
  }
  if (e.source === 'security') return { kind: 'security', category: 'security', host, path, sig }
  if (e.source === 'exception') return { kind: 'exception', category: 'exception', host, path, sig }
  if (e.source === 'console') return { kind: 'console', category: e.level === 'error' ? 'console_error' : 'console_warn', host, path, sig }
  if (e.source === 'browser' && e.level === 'error') return { kind: 'console', category: 'console_error', host, path, sig }
  return null
}

/** Identity of a failure group: same key = same problem, counted instead of logged again. */
export const failureKey = (f: PageFailure): string => `${f.kind}|${f.category}|${f.host}|${f.status ?? ''}|${f.sig}`

const MEDIA_HOST = /(googlevideo\.com|\.youtube\.com|\.ytimg\.com|\.googleusercontent\.com)$/

/** First matching row wins, so the specific rows come before the generic ones. */
const HINTS: ReadonlyArray<{ when: (f: PageFailure) => boolean; hint: string }> = [
  { when: (f) => f.category === 'ERR_BLOCKED_BY_CLIENT', hint: 'Blocked by the built-in webterm blocker (ads/trackers). Usually harmless; if the page still works, ignore it.' },
  { when: (f) => f.category === 'ERR_TUNNEL_CONNECTION_FAILED', hint: 'The webterm outbound proxy refused the connection. See the server events (browser.ssrf.*) for the reason: a blocked private/loopback address, DNS failure or upstream error.' },
  { when: (f) => f.category === 'ERR_PROXY_CONNECTION_FAILED', hint: 'The browser could not reach the webterm outbound proxy. It may have stopped; check browser.launch and browser.ssrf events.' },
  { when: (f) => f.category === 'ERR_NAME_NOT_RESOLVED', hint: 'The host name did not resolve (DNS): misspelled, offline, or the server has no network.' },
  { when: (f) => f.category === 'ERR_CONNECTION_REFUSED', hint: 'Nothing listens at that address and port. For a dev server: it is not running or uses another port.' },
  { when: (f) => f.category === 'ERR_CONNECTION_TIMED_OUT' || f.category === 'ERR_TIMED_OUT', hint: 'The connection timed out: host unreachable or filtered from the webterm machine.' },
  { when: (f) => f.category === 'ERR_CONNECTION_RESET' || f.category === 'ERR_CONNECTION_CLOSED', hint: 'The remote end dropped the connection; often a flaky network, a bot filter or an upstream proxy.' },
  { when: (f) => f.category.startsWith('ERR_CERT_') || f.category === 'ERR_SSL_PROTOCOL_ERROR', hint: 'TLS certificate/handshake problem for that host (expired, self-signed or intercepted).' },
  { when: (f) => f.category === 'ERR_ABORTED', hint: 'The page cancelled the request itself (navigation or player seek). Normally harmless.' },
  { when: (f) => f.status === 403 && /googlevideo\.com$/.test(f.host) && f.path.includes('videoplayback'), hint: 'YouTube refused a media segment (403): expired stream token, bot detection or a blocker. Reload the video; if it persists the provider rejects this browser.' },
  { when: (f) => f.status === 403 && MEDIA_HOST.test(f.host), hint: 'The media host denied the request (403): token expired or the provider rejects this client.' },
  { when: (f) => f.status === 401 || f.status === 403, hint: 'The server refused access (401/403): login required, expired session or bot protection.' },
  { when: (f) => f.status === 404, hint: 'Resource not found (404): wrong URL or a removed asset.' },
  { when: (f) => f.status === 429, hint: 'Rate limited by the site (429); retry later.' },
  { when: (f) => (f.status ?? 0) >= 500, hint: 'The site\'s own server failed (5xx); not a webterm problem.' },
  { when: (f) => f.kind === 'security', hint: 'A browser security policy (CSP, mixed content, CORS) blocked something on the page.' },
  { when: (f) => f.kind === 'exception', hint: 'The page threw an uncaught JavaScript error; read the browser node `console` for the stack.' },
]

/** Plain-language explanation of a failure, or undefined when no row knows it. */
export const hintFor = (f: PageFailure): string | undefined => HINTS.find((h) => h.when(f))?.hint
