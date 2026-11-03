// Cached readiness probe for the `claude` CLI: binary on PATH + `claude auth status`.
// Only the `loggedIn` boolean is ever read from the CLI output; nothing else is returned or logged.
import { spawn } from 'node:child_process'
import { binaryOnPath } from '../../binaryOnPath'

export type ClaudeReady =
  | { ok: true }
  | { ok: false; code: 'claude_not_found' | 'claude_not_authenticated' | 'claude_check_failed'; hint: string }

export interface RunResult {
  code: number | null
  stdout: string
  timedOut: boolean
}
/** Runs one process (argv array, no shell) and resolves with its exit code and captured stdout. */
export type RunFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>

export interface PreflightDeps {
  env: NodeJS.ProcessEnv
  executable?: string
  run?: RunFn
  onPath?: (name: string) => boolean
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

export const READY_TTL_MS = 30_000
export const AUTH_CHECK_TIMEOUT_MS = 5_000
const CLAUDE_BIN = 'claude'
const AUTH_STATUS_ARGS = ['auth', 'status']
const EXIT_NOT_LOGGED_IN = 1
const MAX_STDOUT_BYTES = 64 * 1024

const HINTS = {
  claude_not_found: 'CLI claude tidak ditemukan di PATH. Pasang Claude Code lalu coba lagi.',
  claude_not_authenticated: 'Claude Code belum login. Jalankan "claude auth login" di server.',
  claude_check_failed: 'Pengecekan status Claude Code gagal. Coba lagi sebentar lagi.',
} as const

function notReady(code: keyof typeof HINTS): ClaudeReady {
  return { ok: false, code, hint: HINTS[code] }
}

/** Default RunFn: spawn without a shell, capture capped stdout, kill on timeout. */
export const spawnRun: RunFn = (cmd, args, { env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`spawn ${cmd} failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, timedOut })
    })
  })

/** Reads only `loggedIn` from the status JSON; null when the output is not a JSON object. */
function readLoggedIn(stdout: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed === null || typeof parsed !== 'object') return null
    return (parsed as { loggedIn?: unknown }).loggedIn === true
  } catch {
    // Malformed output is reported by the caller as claude_check_failed; the raw text is never kept.
    return null
  }
}

async function check(d: PreflightDeps): Promise<ClaudeReady> {
  const exe = d.executable ?? CLAUDE_BIN
  const onPath = d.onPath ?? ((name: string) => binaryOnPath(name, d.env['PATH'] ?? ''))
  if (!onPath(CLAUDE_BIN)) return notReady('claude_not_found')
  let result: RunResult
  try {
    result = await (d.run ?? spawnRun)(exe, AUTH_STATUS_ARGS, { env: d.env, timeoutMs: d.timeoutMs ?? AUTH_CHECK_TIMEOUT_MS })
  } catch {
    // Spawn failure: the detail is deliberately dropped (could echo paths/env); the code is the signal.
    return notReady('claude_check_failed')
  }
  if (result.timedOut) return notReady('claude_check_failed')
  if (result.code === EXIT_NOT_LOGGED_IN) return notReady('claude_not_authenticated')
  if (result.code !== 0) return notReady('claude_check_failed')
  const loggedIn = readLoggedIn(result.stdout)
  if (loggedIn === null) return notReady('claude_check_failed')
  return loggedIn ? { ok: true } : notReady('claude_not_authenticated')
}

/** Builds the lazy preflight: concurrent calls share one probe and the result is cached for `ttlMs`. */
export function createClaudePreflight(d: PreflightDeps): () => Promise<ClaudeReady> {
  const now = d.now ?? Date.now
  const ttl = d.ttlMs ?? READY_TTL_MS
  let cached: { at: number; value: Promise<ClaudeReady> } | null = null
  return () => {
    if (cached && now() - cached.at < ttl) return cached.value
    const value = check(d)
    cached = { at: now(), value }
    return value
  }
}
