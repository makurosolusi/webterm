// "Test connection" for command mode: runs the user's launch command headless, argv only (no shell).
//   1. `<wrapper> claude <flags> --version`        proves the command starts at all (no tokens spent)
//   2. `<wrapper> claude <flags> -p . --output-format json`   one minimal request through the command's credential
// Flags per code.claude.com/docs/en/cli-reference (`--version`, `-p`, `--output-format json`). The
// command's stdout/stderr can carry secrets, so neither is ever returned: only the outcome.
import { tmpdir } from 'node:os'
import { defaultOnPath, spawnRun, wrapperSignIn, type RunFn } from '../claudeLauncher/claudeLaunch.probe'
import type { ResolvedClaudeLaunch } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import type { ProbeResult } from './claudeProvider.probe'

export const VERSION_TIMEOUT_MS = 15_000 // a wrapper may fetch its env from a server first
export const PING_TIMEOUT_MS = 45_000
const PING_ARGS = ['-p', '.', '--output-format', 'json']
const NAME_MAX = 40

export interface CommandProbeDeps {
  env: NodeJS.ProcessEnv
  run?: RunFn
  onPath?: (name: string) => boolean
  versionTimeoutMs?: number
  pingTimeoutMs?: number
}

const baseName = (t: string): string => t.slice(t.lastIndexOf('/') + 1)
const safeName = (t: string): string => baseName(t).replace(/[^A-Za-z0-9._+-]/g, '').slice(0, NAME_MAX) || 'The command'

const fail = (outcome: 'command_not_found' | 'command_failed' | 'not_configured', message: string, exitCode?: number | null): ProbeResult =>
  ({ outcome, ok: false, message, ...(exitCode !== undefined && exitCode !== null ? { exitCode } : {}) })

const FAILED_HINT = 'Run the same command in a terminal on the server to see the full error.'

/** Last-stage check: the JSON of `-p --output-format json` reports `is_error`. Nothing else is read. */
function pingSucceeded(stdout: string): boolean {
  try {
    const v: unknown = JSON.parse(stdout)
    return v !== null && typeof v === 'object' && (v as { is_error?: unknown }).is_error !== true
  } catch {
    return false // not JSON: the raw text is dropped, it may hold a secret
  }
}

const isNotFound = (err: unknown): boolean => err instanceof Error && err.message.includes('ENOENT')

/** Probes a resolved launch profile. */
export async function probeCommand(launch: ResolvedClaudeLaunch, d: CommandProbeDeps): Promise<ProbeResult> {
  const run = d.run ?? spawnRun
  const onPath = d.onPath ?? defaultOnPath(d.env)
  const head = launch.argv[0] as string
  const name = safeName(head)
  const notFound = fail('command_not_found', `${name} was not found on PATH. Install it on the server, or fix the command in the launch profile.`)
  if (launch.missingId) return fail('not_configured', 'The selected launch profile no longer exists. Pick another one.')
  if (!onPath(head)) return notFound
  // Fixed cwd: a throwaway directory, not whatever project webterm was started from.
  const exec = async (args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr?: string; timedOut: boolean } | 'enoent' | 'error'> => {
    try { return await run(head, [...launch.argv.slice(1), ...args], { env: d.env, timeoutMs, cwd: tmpdir() }) } catch (err) { return isNotFound(err) ? 'enoent' : 'error' }
  }

  const v = await exec(['--version'], d.versionTimeoutMs ?? VERSION_TIMEOUT_MS)
  if (v === 'enoent') return notFound
  if (v === 'error') return fail('command_failed', `${name} could not be started. ${FAILED_HINT}`)
  if (v.timedOut) return fail('command_failed', `${name} did not answer in time. ${FAILED_HINT}`)
  // Only the outcome leaves this function: the wrapper's text is matched, never returned.
  if (v.code !== 0 && wrapperSignIn(name, `${v.stderr ?? ''}\n${v.stdout}`)) {
    return fail('command_failed', `${name} is not signed in for the user webterm runs as. Sign in on the server, then Test connection again.`, v.code)
  }
  if (v.code !== 0) return fail('command_failed', `The launch command exited with code ${v.code ?? '?'} before Claude Code started. ${FAILED_HINT}`, v.code)

  const p = await exec(PING_ARGS, d.pingTimeoutMs ?? PING_TIMEOUT_MS)
  if (p === 'enoent') return notFound
  if (p === 'error') return fail('command_failed', `${name} could not be started. ${FAILED_HINT}`)
  if (p.timedOut) return fail('command_failed', `Claude Code started but did not answer in time. ${FAILED_HINT}`)
  if (p.code !== 0 || !pingSucceeded(p.stdout)) return fail('command_failed', `Claude Code started but the request did not succeed. ${FAILED_HINT}`, p.code)
  return { outcome: 'ok', ok: true, message: 'Connected: the command started Claude Code and a test request succeeded.' }
}
