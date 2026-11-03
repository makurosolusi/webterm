// Claude Code CLI invocation policy for the central runtime (PLAN CENTRAL-RUNTIME-b 1.2).
// Pure functions: build argv, an allowlisted child environment, and the stdout line framing.
// No spawning, no I/O.
//
// Flags verified against `claude --help` of Claude Code 2.1.317 (minimum tested version):
// --tools, --strict-mcp-config, --permission-mode, --permission-prompts, --safe-mode,
// --include-partial-messages, --session-id, --resume, --max-budget-usd, --model.
// `--max-turns` is absent from that --help but documented upstream; kept [BT] until GATE-S.
// The prompt is never in argv (it goes to stdin) and no permission-bypass flag is ever built.
import { createLogger } from '../../logs'

const log = createLogger('central')

/** Result of the readiness check injected by the wiring layer (CR-02/CR-03). */
export type ClaudeReady =
  | { ok: true }
  | { ok: false; code: ClaudeUnavailableCode; hint: string }

export type ClaudeUnavailableCode = 'claude_not_found' | 'claude_not_authenticated' | 'claude_check_failed'

export interface ClaudeRuntimeOptions {
  /** Executable; defaults to `claude` on PATH (tests: fake `.mjs`). */
  executable?: string
  /** Empty child cwd; defaults to `<dataDir>/central/work` (created 0700). */
  workDir?: string
  /** Parent environment the child env is derived from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Readiness check; `ok:false` fails the turn with `runtime_unavailable` and spawns nothing. */
  preflight?: () => Promise<ClaudeReady>
  /** Grace between SIGINT, SIGTERM and SIGKILL when cancelling. */
  killGraceMs?: number
  newSessionId?: () => string
  /** Raw model setting; defaults to `WEBTERM_CENTRAL_MODEL` (see `claudeModelArg`). */
  model?: string
  /** Cap on input+output tokens summed over unique assistant messages; absent means no cap. */
  maxTokens?: number
  now?: () => number
}

export const DEFAULT_CLAUDE_BIN = 'claude'
export const DEFAULT_KILL_GRACE_MS = 2_000
export const DEFAULT_WALL_MS = 10 * 60_000
/** Fallback `--max-turns`; a tool-less turn needs a single model round trip. */
export const DEFAULT_MAX_TURNS = 4
/** Largest single stdout JSON line kept; longer lines are dropped (also bounds the read buffer). */
export const MAX_LINE_BYTES = 256 * 1024
export const MICROS_PER_USD = 1_000_000
/** Placeholder meaning "no tools at all" for `--tools`. */
const NO_TOOLS_ARG = ''

/** Exact variables forwarded to the child; everything else (provider keys included) is dropped. */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TMPDIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CONFIG_DIR',
])
const ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_']
/** Never forwarded even if someone adds them to the allowlist (root tokens, provider keys). */
const ENV_FORBIDDEN_PREFIXES: readonly string[] = [
  'WEBTERM_', 'NODETERM_', 'ANTHROPIC_', 'OPENAI_', 'CLAUDE_CODE_OAUTH',
]
const CAPABILITY_TOKEN_PREFIX = 'wcap_'

/** Allowlisted child environment: no WEBTERM_/NODETERM_, no provider keys, no capability tokens. */
export function claudeChildEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (!ENV_ALLOWLIST.has(name) && !ENV_ALLOWED_PREFIXES.some((p) => name.startsWith(p))) continue
    if (ENV_FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) continue
    if (value.startsWith(CAPABILITY_TOKEN_PREFIX)) continue
    out[name] = value
  }
  return out
}

export interface ClaudeArgvInput {
  sessionRef?: string
  newSessionId: string
  model?: string
  maxTurns: number
  maxBudgetUsd?: number
}

/** Fixed-order argv: tool-less, MCP-less, deny-by-default; `--resume` only with a sessionRef. */
export function claudeArgv(a: ClaudeArgvInput): string[] {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--tools', NO_TOOLS_ARG, '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--safe-mode',
  ]
  if (a.model !== undefined) args.push('--model', a.model)
  args.push('--max-turns', String(a.maxTurns))
  if (a.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(a.maxBudgetUsd))
  const ref = (a.sessionRef ?? '').trim()
  if (ref.length > 0) args.push('--resume', ref)
  else args.push('--session-id', a.newSessionId)
  return args
}

const MODEL_ALIAS = /^(sonnet|opus|haiku)$/
const MODEL_FULL_ID = /^claude-[A-Za-z0-9._-]+$/
let warnedModel = false

/** Maps `WEBTERM_CENTRAL_MODEL` to `--model`: alias or `claude-*` pass; blank/other ids use the CLI default. */
export function claudeModelArg(raw: string | undefined): { arg?: string; ignored: boolean } {
  const value = (raw ?? '').trim()
  if (value.length === 0) return { ignored: false }
  if (MODEL_ALIAS.test(value) || MODEL_FULL_ID.test(value)) return { arg: value, ignored: false }
  if (!warnedModel) {
    warnedModel = true
    log.warn('central.claude_model_ignored', 'central model is not a Claude alias or id; using the CLI default')
  }
  return { ignored: true }
}

/** Incremental newline splitter; lines over `MAX_LINE_BYTES` are dropped so the buffer stays bounded. */
export function createLineReader(): { push(chunk: string): string[]; end(): string[] } {
  let buf = ''
  let dropping = false
  return {
    push(chunk) {
      const lines: string[] = []
      let start = 0
      for (let nl = chunk.indexOf('\n'); nl >= 0; nl = chunk.indexOf('\n', start)) {
        const line = buf + chunk.slice(start, nl)
        start = nl + 1
        const skip = dropping
        buf = ''
        dropping = false
        if (!skip && line.length <= MAX_LINE_BYTES && line.trim().length > 0) lines.push(line)
      }
      if (!dropping) {
        buf += chunk.slice(start)
        if (buf.length > MAX_LINE_BYTES) {
          buf = ''
          dropping = true
        }
      }
      return lines
    },
    end() {
      const line = buf
      buf = ''
      return !dropping && line.trim().length > 0 ? [line] : []
    },
  }
}
