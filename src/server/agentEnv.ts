// Allowlisted environment for headless agent children: base OS keys plus provider
// credentials, never `WEBTERM_*`/`NODETERM_*` values. Pure, no I/O.

/** Exact strings kept in the child environment; everything else is dropped. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
]

/** Provider credentials an agent CLI may need; only forwarded when already present. */
export const PROVIDER_ENV_ALLOWLIST: readonly string[] = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY',
  'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'AZURE_RESOURCE_NAME', 'OLLAMA_HOST',
]

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
