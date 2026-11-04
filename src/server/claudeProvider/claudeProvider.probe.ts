// "Test connection": the one-token request the Claude Code gateway docs give for verifying a URL +
// credential (code.claude.com/docs/en/llm-gateway-connect#verify-the-connection): POST /v1/messages,
// max_tokens 1. A model error still proves the URL and credential (the request was authenticated
// before the model was rejected); 401 = credential rejected. GET /v1/models is optional for gateways
// (llm-gateway-protocol, model discovery), so it cannot prove anything. Nothing from the request or
// the response body is returned except the Anthropic `error.type` code.
import type { ProviderConfig } from './claudeProvider.model'

export const ANTHROPIC_API = 'https://api.anthropic.com'
export const ANTHROPIC_VERSION = '2023-06-01'
/** Model of the docs' verification request, used when no override is set; a model the gateway lacks still proves auth. */
export const PROBE_MODEL = 'claude-sonnet-4-6'
export const PROBE_TIMEOUT_MS = 10_000

export type ProbeOutcome = 'ok' | 'model_rejected' | 'auth_rejected' | 'http_error' | 'unreachable' | 'not_configured'
export interface ProbeResult { outcome: ProbeOutcome; ok: boolean; status?: number; errorType?: string; message: string }

const ERROR_TYPE = /^[a-z_]{1,60}$/

const MESSAGES: Record<ProbeOutcome, string> = {
  ok: 'Connected: the endpoint answered and accepted the credential.',
  model_rejected: 'The credential was accepted, but the endpoint rejected the model. Set a model it serves.',
  auth_rejected: 'The endpoint rejected the credential. Check the key, or switch between API key and auth token.',
  http_error: 'The endpoint answered with an error.',
  unreachable: 'The endpoint could not be reached. Check the URL and the network.',
  not_configured: 'Set a key first.',
}

const result = (outcome: ProbeOutcome, extra: Partial<ProbeResult> = {}): ProbeResult =>
  ({ outcome, ok: outcome === 'ok' || outcome === 'model_rejected', message: MESSAGES[outcome], ...extra })

async function errorType(res: Response): Promise<string | undefined> {
  try {
    const t = ((await res.json()) as { error?: { type?: unknown } })?.error?.type
    return typeof t === 'string' && ERROR_TYPE.test(t) ? t : undefined
  } catch {
    return undefined // non-JSON body (HTML error page): the status is the signal
  }
}

/** Probes a key mode's endpoint. `fetchFn` is injectable for tests. */
export async function probeProvider(c: ProviderConfig, secret: string | null, fetchFn: typeof fetch = fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (c.mode === 'login' || !secret || (c.mode === 'custom' && !c.baseUrl)) return result('not_configured')
  const base = c.mode === 'custom' ? c.baseUrl as string : ANTHROPIC_API
  const auth: Record<string, string> = c.mode === 'custom' && c.credential === 'authToken' ? { authorization: `Bearer ${secret}` } : { 'x-api-key': secret }
  let res: Response
  try {
    res = await fetchFn(`${base}/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ model: c.model ?? PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
      redirect: 'error', // never follow: a redirect would carry the credential to another host
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return result('unreachable')
  }
  const type = await errorType(res)
  const extra = { status: res.status, ...(type ? { errorType: type } : {}) }
  if (res.ok) return result('ok', extra)
  if (res.status === 401 || res.status === 403) return result('auth_rejected', extra)
  if (res.status === 400 || res.status === 404) return result(type === 'authentication_error' ? 'auth_rejected' : 'model_rejected', extra)
  return result('http_error', { ...extra, message: `${MESSAGES.http_error} (HTTP ${res.status}${type ? `, ${type}` : ''})` })
}
