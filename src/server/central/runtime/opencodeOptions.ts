// OpenCode CLI invocation policy (RND/13 §3 B2). Pure functions: build argv and a
// scrubbed child environment. No spawning, no I/O, no logging.
//
// `opencode run --format json` prints JSONL on stdout; we never pass `--auto`, so
// the CLI cannot run its own mutating tools. Mutating tool families are also
// denied through `OPENCODE_PERMISSION`.
import { join } from 'node:path'
import { flagOn } from '../../envFlag'

export const CENTRAL_MODEL_FLAG = 'WEBTERM_CENTRAL_MODEL'
export const OPENCODE_BIN_FLAG = 'WEBTERM_OPENCODE_BIN'
export const OPENCODE_ALLOW_TOOLS_FLAG = 'WEBTERM_OPENCODE_ALLOW_TOOLS'

export const DEFAULT_OPENCODE_MODEL = 'opencode/deepseek-v4.1-flash-free'
export const DEFAULT_OPENCODE_BIN = 'opencode'

/**
 * `OPENCODE_PERMISSION` is a JSON object parsed by the CLI. `deny` makes the
 * built-in tool fail instead of prompting, which is the safe default for a
 * headless child process. Enabling tools is an explicit opt-in.
 */
export const OPENCODE_PERMISSION_DENY = {
  bash: 'deny',
  edit: 'deny',
  webfetch: 'deny',
  task: 'deny',
} as const

/** Exact strings kept in the child environment; everything else is dropped. */
export const BASE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
]

/** Provider credentials OpenCode may need; only forwarded when already present. */
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

function clean(raw: string | null | undefined, fallback: string): string {
  const value = (raw ?? '').trim()
  return value.length === 0 ? fallback : value
}

/** Model id for `--model`; unset or blank falls back to the free default. */
export function opencodeModel(raw: string | undefined = process.env[CENTRAL_MODEL_FLAG]): string {
  return clean(raw, DEFAULT_OPENCODE_MODEL)
}

/** Executable name/path; unset or blank falls back to `opencode` on PATH. */
export function opencodeBin(raw: string | undefined = process.env[OPENCODE_BIN_FLAG]): string {
  return clean(raw, DEFAULT_OPENCODE_BIN)
}

/** Opt-in switch for mutating built-in tools; anything but `on` keeps them denied. */
export function opencodeToolsAllowed(
  raw: string | undefined = process.env[OPENCODE_ALLOW_TOOLS_FLAG]
): boolean {
  return flagOn(raw)
}

export interface OpencodeArgvOptions {
  prompt: string
  model?: string
  /** Resume handle from a previous turn. */
  sessionRef?: string | null
  /** Optional human-facing session title. */
  title?: string
}

/**
 * `['run', '--standalone', '--format', 'json', '--model', model, ...]`; prompt last, never `--auto`.
 * `--standalone` gives the child a private server: without it opencode v2 tries the managed
 * background service port, which a user's own `opencode serve --service` already holds.
 */
export function buildOpencodeArgs(options: OpencodeArgvOptions): string[] {
  const args = ['run', '--standalone', '--format', 'json', '--model', opencodeModel(options.model)]
  const session = (options.sessionRef ?? '').trim()
  if (session.length > 0) args.push('--session', session)
  const title = (options.title ?? '').trim()
  if (title.length > 0) args.push('--title', title)
  args.push(options.prompt)
  return args
}

/** Keep only allowlisted variables; drop WEBTERM and NODETERM prefixed values and root tokens. */
export function scrubOpencodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV_ALLOWLIST, ...PROVIDER_ENV_ALLOWLIST])
  const out: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    if (FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const value = env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** HOME + XDG_* rooted in one webterm-owned directory, so the child never reads the user's own. */
export function opencodeHomeEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    XDG_CACHE_HOME: join(homeDir, '.cache'),
    XDG_STATE_HOME: join(homeDir, '.local', 'state'),
  }
}

export interface OpencodeInvocation {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export interface OpencodeInvocationOptions extends OpencodeArgvOptions {
  cwd?: string
  executable?: string
  env?: NodeJS.ProcessEnv
  /** Future switch; defaults to `false` so mutating tools stay denied. */
  allowTools?: boolean
  /** When set, replaces the inherited HOME/XDG_* with ones rooted here. */
  homeDir?: string
}

/** Full child invocation: argv plus the scrubbed env with permission policy. */
export function buildOpencodeInvocation(options: OpencodeInvocationOptions): OpencodeInvocation {
  const env = scrubOpencodeEnv(options.env ?? process.env)
  if (options.homeDir !== undefined) Object.assign(env, opencodeHomeEnv(options.homeDir))
  env['OPENCODE_PERMISSION'] = JSON.stringify(
    options.allowTools === true
      ? { bash: 'allow', edit: 'allow', webfetch: 'allow', task: 'allow' }
      : OPENCODE_PERMISSION_DENY
  )
  return {
    executable: clean(options.executable, opencodeBin()),
    args: buildOpencodeArgs(options),
    env,
    cwd: clean(options.cwd, process.cwd()),
  }
}
