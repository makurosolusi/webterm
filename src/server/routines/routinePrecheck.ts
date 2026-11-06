// Shell precheck before a routine wakes an agent: exit 0 = there is work, anything else = skip
// (zero tokens). After Orca `src/main/automations/precheck-runner.ts:131-189`: `shell: true`, own
// process group so a timeout kills the whole tree, output tail capped, never rejects.
import { spawn } from 'node:child_process'
import { childEnv } from '../childEnv'

/** Orca MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS. */
export const PRECHECK_OUTPUT_MAX = 4000
const FORCE_KILL_MS = 2000

export interface PrecheckResult { exitCode: number | null; timedOut: boolean; error: string | null; output: string }

export const precheckPassed = (r: PrecheckResult): boolean => !r.timedOut && !r.error && r.exitCode === 0

/** One-line reason for the run history (no output body: it may quote secrets). */
export function precheckReason(r: PrecheckResult, timeoutSeconds: number): string {
  if (r.timedOut) return `precheck timed out after ${timeoutSeconds}s`
  if (r.error) return `precheck could not start: ${r.error}`
  return `precheck exited ${r.exitCode ?? 'by signal'}`
}

export function runPrecheck(command: string, cwd: string, timeoutSeconds: number): Promise<PrecheckResult> {
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    // env filtered like a PTY (sec-208-7): the precheck is user code and must not see server secrets.
    const child = spawn(command, { cwd, env: childEnv(), shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // Already gone: nothing left to kill.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), FORCE_KILL_MS).unref?.()
    }, timeoutSeconds * 1000)
    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: timedOut ? null : exitCode, timedOut, error, output })
    }
    const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-PRECHECK_OUTPUT_MAX) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (err) => settle(null, err.message))
    child.on('close', (code) => settle(typeof code === 'number' ? code : null, null))
  })
}
