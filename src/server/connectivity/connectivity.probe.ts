// Active probes of the server -> Claude API path. No credentials, no LLM: one bodyless HEAD to the origin of the
// effective base URL. ANY HTTP answer (401/404/5xx included) proves the endpoint is reachable; DNS/TCP/TLS/timeout
// failures do not. A second probe to a neutral public host tells "our network is down" from "the API/proxy is down".
import type { ConnCause, ConnScope } from './connectivity.port'

/** Where Claude Code talks when no `ANTHROPIC_BASE_URL` is configured. */
export const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'
/** Neutral public endpoint answering any request; only its reachability matters. */
export const CONTROL_URL = 'https://www.gstatic.com/generate_204'
export const PROBE_TIMEOUT_MS = 5_000

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export type ProbeResult = { ok: true } | { ok: false; cause: ConnCause }
export type ProbeOutcome = { ok: true } | { ok: false; cause: ConnCause; scope: ConnScope }

const CAUSE_PATTERNS: [ConnCause, RegExp][] = [
  ['dns', /ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i],
  ['tls', /CERT|SSL|TLS|self[- ]signed|certificate/i],
  ['tcp', /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|socket|connect/i],
]

/** Error from fetch -> bounded class; only the class leaves this function, never the message (it can hold the URL). */
export function classifyProbeError(err: unknown, timedOut: boolean): ConnCause {
  if (timedOut) return 'timeout'
  const e = err as { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null
  const text = [e?.code, e?.name, e?.message, e?.cause?.code, e?.cause?.message].filter((v) => typeof v === 'string').join(' ')
  if (/ETIMEDOUT|TimeoutError|timed out/i.test(text)) return 'timeout'
  return CAUSE_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? 'unknown'
}

/** The probe target: the origin only (path, query and `user:pass@` dropped), so nothing sensitive is ever requested or logged. */
export function probeTarget(baseUrl: string | undefined): string {
  if (!baseUrl) return DEFAULT_API_BASE_URL
  try { return new URL(baseUrl.trim()).origin } catch { return DEFAULT_API_BASE_URL }
}

/** One probe; never throws. No headers, no body, no cookies: a bare request cannot leak a credential. */
export async function probeOnce(fetchFn: FetchFn, url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctl.abort() }, timeoutMs)
  try {
    const res = await fetchFn(url, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: ctl.signal })
    void res.body?.cancel().catch(() => undefined)
    return { ok: true }
  } catch (err) {
    return { ok: false, cause: classifyProbeError(err, timedOut) }
  } finally {
    clearTimeout(timer)
  }
}

/** API probe, then (only on failure) the control probe to name the scope. */
export async function probeConnectivity(fetchFn: FetchFn, apiUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeOutcome> {
  const api = await probeOnce(fetchFn, apiUrl, timeoutMs)
  if (api.ok) return api
  const control = await probeOnce(fetchFn, CONTROL_URL, timeoutMs)
  return { ok: false, cause: api.cause, scope: control.ok ? 'api' : 'network' }
}
