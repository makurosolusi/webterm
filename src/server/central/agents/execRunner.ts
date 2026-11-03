// Headless worker runner (RND/22 4.3): argv ARRAY via child_process.spawn (works in Bun), no shell, scrubbed env, JSONL on stdout.
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { scrubOpencodeEnv } from '../runtime/opencodeOptions'

/** Default cap on retained stdout (bytes of text); older output is dropped. */
export const EXEC_TAIL_BYTES = 64 * 1024
const MAX_LINE_CHARS = 1024 * 1024
const FORBIDDEN_NAME = /^(WEBTERM_|NODETERM_)/
const CAPABILITY_VALUE = /wcap_/

export interface ExecSpec {
  /** `[executable, ...args]`; never joined into a shell string. */
  argv: readonly string[]
  /** Absolute working directory (the agent worktree). */
  cwd: string
  /** Source env to scrub; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Extra vars (e.g. sandbox HOME) applied after the scrub; `WEBTERM_`/`NODETERM_` names are dropped. */
  overrides?: Record<string, string>
  timeoutMs: number
  tailBytes?: number
}

export interface ExecOutcome {
  exitCode: number | null
  timedOut: boolean
  killed: boolean
  /** Last stdout line that parsed as a JSON object (the final event of `--format json` CLIs). */
  lastEvent: Record<string, unknown> | null
  tail: string
  /** errno code when the process could not start. */
  error?: string
}

export interface ExecHandle {
  pid: number
  /** Never rejects; resolves once the process ended and stdout was drained. */
  done: Promise<ExecOutcome>
  /** Current retained stdout. */
  tail(): string
  kill(): void
}

/** Allowlisted env for a child: no `WEBTERM_*`/`NODETERM_*`, no value that looks like a `wcap_` capability. */
export function scrubExecEnv(source: NodeJS.ProcessEnv = process.env, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  const keep = (name: string, value: string | undefined): void => {
    if (value !== undefined && !FORBIDDEN_NAME.test(name) && !CAPABILITY_VALUE.test(value)) out[name] = value
  }
  for (const [name, value] of Object.entries(scrubOpencodeEnv(source))) keep(name, value)
  for (const [name, value] of Object.entries(overrides)) keep(name, value)
  return out
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    // Non-JSON stdout lines (banners, progress) are expected from CLIs and are not events.
    return null
  }
}

/** Starts the process; throws `invalid_exec_spec` for a bad argv/cwd/timeout before anything runs. */
export function startExec(spec: ExecSpec): ExecHandle {
  const { argv } = spec
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || !argv[0]) throw new Error('invalid_exec_spec: argv must be a non-empty string array')
  if (!isAbsolute(spec.cwd)) throw new Error('invalid_exec_spec: cwd must be absolute')
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new Error('invalid_exec_spec: timeoutMs must be positive')
  // node:child_process works under Bun and Node; `shell` is off, so argv is never parsed by a shell.
  const proc = spawn(argv[0], argv.slice(1), { cwd: spec.cwd, env: scrubExecEnv(spec.env, spec.overrides), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  const limit = spec.tailBytes ?? EXEC_TAIL_BYTES
  let tail = ''
  let pending = ''
  let lastEvent: Record<string, unknown> | null = null
  let timedOut = false
  let killed = false
  let error: string | undefined
  const stop = (): void => { killed = true; proc.kill('SIGKILL') }
  const timer = setTimeout(() => { timedOut = true; stop() }, spec.timeoutMs)
  const onLine = (line: string): void => { const event = line.trim() ? parseObject(line) : null; if (event) lastEvent = event }
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (text: string) => {
    tail = (tail + text).slice(-limit)
    const lines = (pending + text).split('\n')
    pending = (lines.pop() ?? '').slice(-MAX_LINE_CHARS)
    lines.forEach(onLine)
  })
  proc.stderr.resume()
  const done = new Promise<ExecOutcome>((resolve) => {
    const finish = (exitCode: number | null): void => {
      clearTimeout(timer)
      onLine(pending)
      resolve({ exitCode: killed ? null : exitCode, timedOut, killed, lastEvent, tail, ...(error ? { error } : {}) })
    }
    // Spawn failure (e.g. ENOENT): only the errno code is kept, the message may carry paths.
    proc.once('error', (err: NodeJS.ErrnoException) => { error = err.code ?? err.name; finish(null) })
    proc.once('close', (code) => finish(code))
  })
  return { pid: proc.pid ?? -1, done, tail: () => tail, kill: stop }
}
