// Allowlisted environment for headless agent children: base OS keys plus provider
// credentials, never `WEBTERM_*`/`NODETERM_*` values. Pure, no I/O.

/** Exact strings kept in the child environment; everything else is dropped. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
]

/** Claude provider credentials and endpoint (incl. an `ANTHROPIC_BASE_URL` proxy); only forwarded
 *  when already present. Other CLIs' provider keys are not forwarded (Claude-first). */
export const PROVIDER_ENV_ALLOWLIST: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

/** Prefixes that must never reach the child, even if allowlisted by mistake. */
const FORBIDDEN_PREFIXES = ['WEBTERM_', 'NODETERM_']

/** Keep only allowlisted variables; drop WEBTERM and NODETERM prefixed values and root tokens. */
export function scrubAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV_ALLOWLIST, ...PROVIDER_ENV_ALLOWLIST])
  const out: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    if (FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}
