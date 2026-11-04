// Claude provider: which credential every Claude Code process webterm starts uses. Pure (no I/O).
// Env names and precedence follow code.claude.com/docs/en/authentication#authentication-precedence:
// cloud provider flags > ANTHROPIC_AUTH_TOKEN (Bearer) > ANTHROPIC_API_KEY (x-api-key) > apiKeyHelper >
// CLAUDE_CODE_OAUTH_TOKEN > /login. So a mode sets its own variable AND clears every one that would
// outrank it, or an inherited ANTHROPIC_AUTH_TOKEN would silently win over the key chosen here.

export type ProviderMode = 'login' | 'apiKey' | 'custom'
/** Header the custom endpoint reads: `apiKey` = x-api-key (ANTHROPIC_API_KEY), `authToken` = Bearer (ANTHROPIC_AUTH_TOKEN). */
export type CredentialKind = 'apiKey' | 'authToken'

export interface ProviderConfig {
  mode: ProviderMode
  /** Custom mode only: Anthropic-compatible base URL (no `/v1`). */
  baseUrl?: string
  /** Custom mode only. */
  credential?: CredentialKind
  /** Optional ANTHROPIC_MODEL override (both key modes). */
  model?: string
  /** Epoch ms of the last change: sessions started before it show a restart hint. */
  updatedAt?: number
}

/** What the API/UI may see: never the secret, only whether one is stored. */
export interface ProviderView extends ProviderConfig { secretSet: boolean; ready: boolean }

/** Env change for one Claude process: `set` wins, `unset` is removed from the inherited env. */
export interface ProviderEnv { set: Record<string, string>; unset: string[] }

export const DEFAULT_CONFIG: ProviderConfig = { mode: 'login' }
export const MODES: readonly ProviderMode[] = ['login', 'apiKey', 'custom']
export const MODEL_MAX = 200
export const SECRET_MIN = 8
export const SECRET_MAX = 8 * 1024
const MODEL_RE = /^[A-Za-z0-9._:/@[\]-]+$/

/** Variables that would outrank or redirect the chosen credential. */
export const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE'] as const
/** Credential/endpoint variables a key mode owns: whichever it does not set is cleared. */
export const PROVIDER_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const
/** Strips credentials from Bash/hook/MCP subprocesses of the claude process (docs: env-vars, "What the subprocess environment scrub removes"). */
export const SCRUB_VAR = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'

/** http(s) URL without credentials, query or fragment; trailing `/` and a trailing `/v1` are dropped. */
export function normalizeBaseUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return null
  return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`
}

export const isReady = (c: ProviderConfig, secretSet: boolean): boolean =>
  c.mode === 'login' || (secretSet && (c.mode === 'apiKey' || !!c.baseUrl))

/**
 * Env for one Claude process. Login mode changes nothing (Claude Code uses its own login). Key modes
 * set exactly one credential variable, clear the others and the cloud flags, and turn on the
 * subprocess scrub so the agent's own tools do not inherit the key.
 */
export function providerEnv(c: ProviderConfig, secret: string | null): ProviderEnv {
  if (c.mode === 'login' || !secret || !isReady(c, true)) return { set: {}, unset: [] }
  const credVar = c.mode === 'custom' && c.credential === 'authToken' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'
  const set: Record<string, string> = { [credVar]: secret, [SCRUB_VAR]: '1' }
  if (c.mode === 'custom' && c.baseUrl) set.ANTHROPIC_BASE_URL = c.baseUrl
  if (c.model) set.ANTHROPIC_MODEL = c.model
  const unset = [...PROVIDER_VARS, ...CLOUD_FLAGS].filter((k) => !(k in set))
  return { set, unset }
}

/** `base` with the provider env applied (unset keys removed). Returns a new object. */
export function applyProviderEnv(base: Record<string, string | undefined>, pe: ProviderEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !pe.unset.includes(k)) out[k] = v
  return Object.assign(out, pe.set)
}

export type ParseResult = { ok: true; config: ProviderConfig; secret?: string | null } | { ok: false; error: string }

/**
 * Validates a PUT body `{ mode, baseUrl?, credential?, model?, secret? }`. `secret` absent = keep the
 * stored one, `''` = remove it. Errors are static codes: the body (which may hold a key) is never echoed.
 */
export function parseUpdate(body: unknown): ParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' }
  const b = body as Record<string, unknown>
  if (typeof b.mode !== 'string' || !(MODES as readonly string[]).includes(b.mode)) return { ok: false, error: 'invalid_mode' }
  const config: ProviderConfig = { mode: b.mode as ProviderMode }
  if (config.mode === 'custom') {
    const url = typeof b.baseUrl === 'string' ? normalizeBaseUrl(b.baseUrl) : null
    if (!url) return { ok: false, error: 'invalid_base_url' }
    config.baseUrl = url
    config.credential = b.credential === 'apiKey' ? 'apiKey' : 'authToken'
  }
  if (config.mode !== 'login' && b.model !== undefined && b.model !== '') {
    if (typeof b.model !== 'string' || b.model.length > MODEL_MAX || !MODEL_RE.test(b.model.trim())) return { ok: false, error: 'invalid_model' }
    config.model = b.model.trim()
  }
  if (b.secret === undefined) return { ok: true, config }
  if (b.secret === '') return { ok: true, config, secret: null }
  if (typeof b.secret !== 'string' || b.secret.trim().length < SECRET_MIN || b.secret.length > SECRET_MAX || /\s/.test(b.secret.trim())) {
    return { ok: false, error: 'invalid_secret' }
  }
  return { ok: true, config, secret: b.secret.trim() }
}
