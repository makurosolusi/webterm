// Staged readiness probe of one Claude launch profile: wrapper on PATH -> wrapper runs claude
// (`--version`) -> `claude auth status`. Argv only, never a shell. Only `loggedIn`/`authMethod` are
// read from the CLI output; the wrapper's first stderr line is shown redacted, nothing else is kept.
// `claude auth status`: JSON, exit 0 logged in / 1 not, `authMethod` one of none|claude.ai|
// oauth_token|api_key|api_key_helper|third_party (https://code.claude.com/docs/en/cli-reference).
// An env credential (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN injected by a wrapper) reports
// loggedIn:true with authMethod api_key / oauth_token, so it counts as ready.
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { envProxyAuth } from '../agentEnv'
import { binaryOnPath } from '../binaryOnPath'
import { redactSecrets } from '../redactSecrets'
import { isClaudeToken } from '../../shared/claudeLaunch/claudeLaunch.normalize'
import type { ResolvedClaudeLaunch } from '../../shared/claudeLaunch/claudeLaunch.profiles'

export interface RunResult { code: number | null; stdout: string; stderr?: string; timedOut: boolean }
/** Runs one process (argv array, no shell) and resolves with its exit code and captured output. */
export type RunFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd?: string; signal?: AbortSignal }) => Promise<RunResult>

export type LaunchStage = 'wrapper' | 'claude' | 'auth'
export type LaunchFailure = 'wrapper_not_found' | 'wrapper_failed' | 'wrapper_signed_out' | 'claude_not_found' | 'auth_failed' | 'check_failed'
/** `install`: on a claude-missing step, the official install commands for the UI to show with a copy button.
 *  `signIn`: on a wrapper that is not signed in, the sign-in command the wrapper itself suggested. */
export interface StageResult { stage: LaunchStage; ok: boolean; message: string; hint?: string; install?: ClaudeInstall; signIn?: WrapperSignIn
  /** The stage was killed at its timeout: the result says nothing about the profile itself. */
  timedOut?: true }
export interface WrapperSignIn { tool: string; hint: string; command?: string }
export interface ClaudeInstall { installCommand: string; npmCommand: string; docsUrl: string }

/** Official Claude Code install (https://code.claude.com/docs/en/setup, checked 2026-11-11): native
 *  installer for macOS/Linux/WSL (the server's platforms), npm as the alternative (Node.js 22+). */
export const CLAUDE_INSTALL: ClaudeInstall = {
  installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
  npmCommand: 'npm install -g @anthropic-ai/claude-code',
  docsUrl: 'https://code.claude.com/docs/en/setup',
}
export interface LaunchProbe {
  ok: boolean
  profile: { id: string; name: string }
  steps: StageResult[]
  failed?: LaunchFailure
}

export interface ProbeDeps {
  env: NodeJS.ProcessEnv
  run?: RunFn
  onPath?: (name: string) => boolean
  timeoutMs?: number
  /** Claude provider mode: a key/endpoint provider needs no Claude Code login. */
  provider?: { mode: string; ready: boolean }
  /** Also run `claude --version` on an unwrapped launch (the wrapped one always does), for the version shown. */
  version?: boolean
  /** Each stage result as it is decided (Test connection streams them). */
  onStep?: (s: StageResult) => void
  /** Kills a running stage (everyone watching the test left). */
  signal?: AbortSignal
}

export const AUTH_CHECK_TIMEOUT_MS = 5_000
/** A wrapper may fetch env from a server (envman) before claude even starts. */
export const WRAPPED_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SHOWN_CHARS = 200
const EXIT_NOT_LOGGED_IN = 1
const AUTH_METHODS = new Set(['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'])
const NOT_FOUND = /not found|no such file|cannot find/i

export const PROBE_TEXT = {
  wrapperMissing: (w: string): string => `${w} not found on PATH`,
  wrapperMissingHint: 'Install it on the server, or fix the command in the launch profile.',
  wrapperOk: (w: string): string => `${w} runs claude`,
  wrapperFailed: (w: string, code: number | null, line: string): string => `${w} exited with code ${code ?? '?'}${line ? `: ${line}` : ''}`,
  wrapperFailedHint: 'Run the same command in a terminal on the server to see the full error.',
  wrapperSignedOut: (w: string): string => `${w} is not signed in for the user webterm runs as. Sign in, then Check again.`,
  wrapperTimeout: (w: string): string => `${w} did not finish in time`,
  wrapperSpawn: (w: string): string => `${w} could not be started`,
  claudeMissing: `The claude CLI was not found on PATH. Install Claude Code on the server (${CLAUDE_INSTALL.installCommand}) and try again.`,
  claudeMissingHint: `Alternative: ${CLAUDE_INSTALL.npmCommand}. Afterwards open a new terminal so claude is on PATH.`,
  claudeMissingWrapped: (w: string): string => `${w} could not find claude`,
  claudeOk: (v: string): string => (v ? `claude ${v}` : 'claude found'),
  claudeVersionFailed: (code: number | null): string => `claude --version did not succeed${code === null ? '' : ` (exit code ${code})`}`,
  authOk: (m: string): string => (m === 'api_key' || m === 'oauth_token' ? `Signed in with a credential from the environment (${m})` : `Signed in${m ? ` (${m})` : ''}`),
  authProvider: 'Using the Claude provider from Settings › Capabilities',
  authEnvProxy: 'Using the proxy from the server environment (ANTHROPIC_BASE_URL)',
  authMissing: 'Claude Code is not signed in.',
  authHint: 'Run "claude auth login" on the server.',
  authHintWrapped: 'Run "claude auth login" on the server, or let the wrapper provide ANTHROPIC_API_KEY.',
  providerNotReady: 'The Claude provider has no key yet. Add it in Settings › Capabilities › Claude provider.',
  checkFailed: 'Checking Claude Code status failed. Try again in a moment.',
}

/** Default RunFn: spawn without a shell, capture capped stdout/stderr, kill on timeout. */
export const spawnRun: RunFn = (cmd, args, { env, timeoutMs, cwd, signal }) =>
  new Promise((resolve, reject) => {
    // Own process group: a wrapper (envman, op run) execs claude as a child, and killing only the wrapper
    // would leave that child holding the pipes open until it ends on its own.
    const child = spawn(cmd, args, { env, cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (r: RunResult): void => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    const kill = (): void => {
      try { process.kill(-(child.pid as number), 'SIGKILL') } catch { child.kill('SIGKILL') } // group gone/unsupported: kill the child itself
      finish({ code: null, stdout, stderr, timedOut: true })
    }
    const timer = setTimeout(kill, timeoutMs)
    // An abort ends the run like a timeout; the caller knows it aborted and reports that instead.
    if (signal?.aborted) kill()
    else signal?.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += c })
    child.stderr.on('data', (c: string) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += c })
    child.once('error', (err) => {
      clearTimeout(timer)
      if (!done) { done = true; reject(new Error(`spawn ${cmd} failed: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)) }
    })
    child.once('close', (code) => finish({ code, stdout, stderr, timedOut: false }))
  })

const baseName = (t: string): string => t.slice(t.lastIndexOf('/') + 1)

/** A path is checked as-is; a bare name is searched on the child's PATH. */
export function defaultOnPath(env: NodeJS.ProcessEnv): (name: string) => boolean {
  return (name) => {
    if (!name.includes('/')) return binaryOnPath(name, env['PATH'] ?? '')
    try { accessSync(name, constants.X_OK); return true } catch { return false } // absent/not executable = the answer
  }
}

/** First non-empty line, redacted and capped: the only wrapper output that is ever shown. */
const firstLine = (text = ''): string =>
  redactSecrets(text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '').slice(0, MAX_SHOWN_CHARS)

// Wrapper "please sign in" messages: envman ("not logged in", "need auth"), 1Password op ("not currently
// signed in"), doppler ("you must provide a token"), and the common "login required"/"must log in".
const SIGNED_OUT = /not (?:currently )?(?:logged|signed) in|need auth|login required|must (?:log|sign) ?in|must provide a token/i
const QUOTED = /['"`]([^'"`\n]+)['"`]/g
const SIGN_IN_VERB = /\b(?:login|signin|sign-in|auth)\b/

/** The wrapper's own sign-in message -> structured hint; the suggested command is taken verbatim from a
 *  quoted `<tool> login ...` in the (already redacted) output, never invented. null = not a sign-in failure. */
export function wrapperSignIn(tool: string, text: string): WrapperSignIn | null {
  if (!SIGNED_OUT.test(text)) return null
  const command = [...text.matchAll(QUOTED)].map((m) => (m[1] as string).trim())
    .find((c) => c.split(/\s+/)[0] === tool && SIGN_IN_VERB.test(c))
  return { tool, hint: PROBE_TEXT.wrapperSignedOut(tool), ...(command ? { command: command.slice(0, MAX_SHOWN_CHARS) } : {}) }
}

/** `authMethod` only when it is one of the documented values (never free text from the CLI). */
function readAuth(stdout: string): { loggedIn: boolean; method: string } | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (parsed === null || typeof parsed !== 'object') return null
    const { loggedIn, authMethod } = parsed as { loggedIn?: unknown; authMethod?: unknown }
    return { loggedIn: loggedIn === true, method: typeof authMethod === 'string' && AUTH_METHODS.has(authMethod) ? authMethod : '' }
  } catch {
    return null // malformed output: reported as check_failed by the caller; the raw text is not kept
  }
}

/** Probe one resolved launch. Stops at the first failing stage. */
export async function probeClaudeLaunch(launch: ResolvedClaudeLaunch, d: ProbeDeps): Promise<LaunchProbe> {
  const run = d.run ?? spawnRun
  const onPath = d.onPath ?? defaultOnPath(d.env)
  const steps: StageResult[] = []
  const push = (s: StageResult): void => { steps.push(s); d.onStep?.(s) }
  const profile = { id: launch.profile.id, name: launch.profile.name }
  const fail = (stage: LaunchStage, failed: LaunchFailure, message: string, hint?: string, timedOut = false): LaunchProbe => {
    push({ stage, ok: false, message, ...(hint ? { hint } : {}), ...(failed === 'claude_not_found' ? { install: CLAUDE_INSTALL } : {}), ...(timedOut ? { timedOut: true as const } : {}) })
    return { ok: false, profile, steps, failed }
  }
  const wrapped = launch.wrapper.length > 0
  const timeoutMs = d.timeoutMs ?? (wrapped ? WRAPPED_TIMEOUT_MS : AUTH_CHECK_TIMEOUT_MS)
  // Probe argv: subcommands go right after claude (its flags may not precede them); a custom script
  // that is not claude itself keeps its own arguments.
  const head = isClaudeToken(launch.bin) ? [...launch.wrapper, launch.bin] : launch.argv
  const exec = (args: string[]): Promise<RunResult> => run(head[0] as string, [...head.slice(1), ...args], { env: d.env, timeoutMs, ...(d.signal ? { signal: d.signal } : {}) })

  if (wrapped) {
    const w = baseName(launch.wrapper[0] as string)
    if (!onPath(launch.wrapper[0] as string)) return fail('wrapper', 'wrapper_not_found', PROBE_TEXT.wrapperMissing(w), PROBE_TEXT.wrapperMissingHint)
    let r: RunResult
    try { r = await exec(['--version']) } catch { return fail('wrapper', 'wrapper_failed', PROBE_TEXT.wrapperSpawn(w), PROBE_TEXT.wrapperFailedHint) }
    if (r.timedOut) return fail('wrapper', 'wrapper_failed', PROBE_TEXT.wrapperTimeout(w), PROBE_TEXT.wrapperFailedHint, true)
    if (r.code !== 0) {
      const line = firstLine(r.stderr) || firstLine(r.stdout)
      if (NOT_FOUND.test(line) && line.includes(baseName(launch.bin))) {
        push({ stage: 'wrapper', ok: true, message: PROBE_TEXT.wrapperOk(w) })
        return fail('claude', 'claude_not_found', PROBE_TEXT.claudeMissingWrapped(w), PROBE_TEXT.claudeMissing)
      }
      const output = redactSecrets(`${r.stderr ?? ''}\n${r.stdout}`).slice(0, MAX_OUTPUT_BYTES)
      const signIn = wrapperSignIn(w, output)
      if (signIn) {
        push({ stage: 'wrapper', ok: false, message: PROBE_TEXT.wrapperFailed(w, r.code, line), hint: signIn.hint, signIn })
        return { ok: false, profile, steps, failed: 'wrapper_signed_out' }
      }
      // "See the full error" only when the shown line is not all of it (no output, capped, or more lines).
      const more = !line || line.length >= MAX_SHOWN_CHARS || output.split('\n').filter((l) => l.trim() !== '').length > 1
      return fail('wrapper', 'wrapper_failed', PROBE_TEXT.wrapperFailed(w, r.code, line), more ? PROBE_TEXT.wrapperFailedHint : undefined)
    }
    push({ stage: 'wrapper', ok: true, message: PROBE_TEXT.wrapperOk(w) })
    push({ stage: 'claude', ok: true, message: PROBE_TEXT.claudeOk(firstLine(r.stdout).slice(0, 60)) })
  } else {
    if (!onPath(launch.bin)) return fail('claude', 'claude_not_found', PROBE_TEXT.claudeMissing, PROBE_TEXT.claudeMissingHint)
    let version = ''
    if (d.version) {
      let r: RunResult
      try { r = await exec(['--version']) } catch { return fail('claude', 'check_failed', PROBE_TEXT.claudeVersionFailed(null), PROBE_TEXT.wrapperFailedHint) }
      if (r.timedOut || r.code !== 0) return fail('claude', 'check_failed', PROBE_TEXT.claudeVersionFailed(r.code), PROBE_TEXT.wrapperFailedHint, r.timedOut)
      version = firstLine(r.stdout).slice(0, 60)
    }
    push({ stage: 'claude', ok: true, message: PROBE_TEXT.claudeOk(version) })
  }

  // Login and command mode both rely on Claude Code's own status (a command's wrapper supplies the credential).
  if (d.provider && d.provider.mode !== 'login' && d.provider.mode !== 'command') {
    if (!d.provider.ready) return fail('auth', 'auth_failed', PROBE_TEXT.providerNotReady)
    push({ stage: 'auth', ok: true, message: PROBE_TEXT.authProvider })
    return { ok: true, profile, steps }
  }
  if (envProxyAuth(d.env)) {
    push({ stage: 'auth', ok: true, message: PROBE_TEXT.authEnvProxy })
    return { ok: true, profile, steps }
  }
  const hint = wrapped ? PROBE_TEXT.authHintWrapped : PROBE_TEXT.authHint
  let r: RunResult
  try { r = await exec(['auth', 'status']) } catch { return fail('auth', 'check_failed', PROBE_TEXT.checkFailed) } // detail dropped: could echo paths/env
  if (r.timedOut) return fail('auth', 'check_failed', PROBE_TEXT.checkFailed, undefined, true)
  if (r.code === EXIT_NOT_LOGGED_IN) return fail('auth', 'auth_failed', PROBE_TEXT.authMissing, hint)
  if (r.code !== 0) return fail('auth', 'check_failed', PROBE_TEXT.checkFailed)
  const auth = readAuth(r.stdout)
  if (auth === null) return fail('auth', 'check_failed', PROBE_TEXT.checkFailed)
  if (!auth.loggedIn) return fail('auth', 'auth_failed', PROBE_TEXT.authMissing, hint)
  push({ stage: 'auth', ok: true, message: PROBE_TEXT.authOk(auth.method) })
  return { ok: true, profile, steps }
}
