// Allowlisted environment for headless agent children: base OS keys plus provider vars (a real
// credential is replaced by the credential-proxy placeholder), never `WEBTERM_*` (or legacy `NODETERM_*`) values.
import { envHasCredential, proxyChildVars, requireProxy } from './credentialProxy/credentialProxy.env'

/** Exact strings kept in the child environment; everything else is dropped. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
]

/** The one list of provider vars that may reach a Claude child (docs: code.claude.com/docs/en/env-vars):
 *  endpoint + credential, `ANTHROPIC_CUSTOM_HEADERS` (proxy auth headers) and the model vars.
 *  Precedence: Provider card (custom) > launch profile wrapper (envman, sets env at exec) > server env/.env > /login. */
export const PROVIDER_ENV_ALLOWLIST: readonly string[] = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
]
/** Credential vars: forbidden in any child env except as the proxy placeholder. */
export const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']
/** Claude's subprocess scrub (needs bwrap on Linux). webterm never sets it: the proxy leaves nothing to scrub; it is only ever unset. */
export const SCRUB_VAR = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'

/** Claude Code CLI retry watchdog (docs env-vars, v2.1.295+): 429/529 retried without bound, other transient errors up to ~3h. */
export const RETRY_WATCHDOG_VAR = 'CLAUDE_CODE_RETRY_WATCHDOG'

/**
 * The watchdog var for an agent session: an explicit value in `env` (user or provider, `0` included) is kept
 * as is, otherwise `1`, so a worker rides out an outage instead of dying (zero-config). Unknown to an older CLI = ignored.
 * Single source for every spawn path (PTY, headless exec, agent chat).
 */
export function retryWatchdogEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return { [RETRY_WATCHDOG_VAR]: env[RETRY_WATCHDOG_VAR] ?? '1' }
}

/** `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` (v2.1.309+): continue a turn cut off by a dead process; the age var bounds how stale it may be. */
export const RESUME_TURN_VAR = 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN'
export const RESUME_TURN_MAX_AGE_VAR = 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS'

/** Shell prefix `VAR=value ...` that makes one resumed claude continue its interrupted turn (values are ours, digits only). */
export function resumeTurnPrefix(maxAgeMs: number): string {
  return `${RESUME_TURN_VAR}=1 ${RESUME_TURN_MAX_AGE_VAR}=${Math.max(1, Math.floor(maxAgeMs))}`
}

/** Provider vars of `env` for a child: model/endpoint vars as is, a credential replaced by the proxy placeholder + URL (throws `credential_proxy_unavailable` without a proxy). */
export function providerEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const hasCred = envHasCredential(env)
  const out: Record<string, string> = {}
  for (const name of PROVIDER_ENV_ALLOWLIST) {
    const value = env[name]
    if (value !== undefined && !CREDENTIAL_VARS.includes(name) && !(hasCred && name === 'ANTHROPIC_BASE_URL')) out[name] = value
  }
  return hasCred ? { ...out, ...proxyChildVars(requireProxy()) } : out
}

/** Endpoint plus credential in `env`: a proxy is configured, no Claude Code login is needed. */
export const envProxyAuth = (env: NodeJS.ProcessEnv): boolean =>
  !!env.ANTHROPIC_BASE_URL && (!!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY)

/** Prefixes that must never reach the child, even if allowlisted by mistake. */
// legacy: `NODETERM_` = pre-rename names, still scrubbed (inherited from an old parent env); remove after 0.10.0.
const FORBIDDEN_PREFIXES = ['WEBTERM_', 'NODETERM_']

/** Keep only allowlisted variables; drop WEBTERM_ (and legacy NODETERM_) prefixed values and root tokens. */
export function scrubAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...providerEnvFrom(env), ...retryWatchdogEnv(env) }
  for (const name of BASE_ENV_ALLOWLIST) {
    if (FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}
