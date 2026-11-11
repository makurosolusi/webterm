// Allowlisted environment for headless agent children: base OS keys plus provider
// credentials, never `WEBTERM_*`/`NODETERM_*` values. Pure, no I/O.

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
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']
/** Strips credentials from Bash/hook/MCP subprocesses of the claude process (docs: env-vars, "What the subprocess environment scrub removes"). */
export const SCRUB_VAR = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'

/** Provider vars present in `env`; a forwarded credential turns on the subprocess scrub, as the Provider card does. */
export function providerEnvFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PROVIDER_ENV_ALLOWLIST) {
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  if (CREDENTIAL_VARS.some((name) => name in out)) out[SCRUB_VAR] = '1'
  return out
}

/** Endpoint plus credential in `env`: a proxy is configured, no Claude Code login is needed. */
export const envProxyAuth = (env: NodeJS.ProcessEnv): boolean =>
  !!env.ANTHROPIC_BASE_URL && (!!env.ANTHROPIC_AUTH_TOKEN || !!env.ANTHROPIC_API_KEY)

/** Prefixes that must never reach the child, even if allowlisted by mistake. */
const FORBIDDEN_PREFIXES = ['WEBTERM_', 'NODETERM_']

/** Keep only allowlisted variables; drop WEBTERM and NODETERM prefixed values and root tokens. */
export function scrubAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = providerEnvFrom(env)
  for (const name of BASE_ENV_ALLOWLIST) {
    if (FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}
