// Production exec for verify commands: no shell, clean env, output cap, and a timeout that kills the
// WHOLE process tree. `npm test` -> sh -> vitest is a tree; `execFile({timeout})` signals only `npm`,
// so the grandchildren kept running. Same own-group kill as gitScm.run / claudeLaunch.probe.
import { type ChildProcess, spawn } from 'node:child_process'
import { cleanEnv } from './verifyEnv'
import type { VerifyExec, VerifyExecResult } from './verify'

/** Grace between SIGTERM to the group and the SIGKILL that forces stragglers. */
export const VERIFY_KILL_GRACE_MS = 2_000
const MIN_OUTPUT_BYTES = 1024

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, signal) } catch { child.kill(signal) } // group already gone/unsupported: signal the leader (never throws)
}

/** Exec produksi: spawn (shell: false) in its own process group, timeout + output cap kill the group. */
export function createProcessExec(source: NodeJS.ProcessEnv = process.env): VerifyExec {
  return (file, args, options) =>
    new Promise<VerifyExecResult>((resolveRun) => {
      const maxBytes = Math.max(MIN_OUTPUT_BYTES, options.maxOutputBytes)
      const child = spawn(file, args, { cwd: options.cwd, env: cleanEnv(source), shell: false, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let timedOut = false
      let truncated = false
      let force: ReturnType<typeof setTimeout> | undefined
      const stop = (): void => {
        killGroup(child, 'SIGTERM')
        force ??= setTimeout(() => killGroup(child, 'SIGKILL'), VERIFY_KILL_GRACE_MS)
        force.unref()
      }
      const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
      const take = (chunk: string, into: 'out' | 'err'): void => {
        if (truncated) return
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (into === 'out') stdout += chunk
        else stderr += chunk
        if (bytes > maxBytes) { truncated = true; stop() }
      }
      child.stdout.setEncoding('utf8').on('data', (c: string) => take(c, 'out'))
      child.stderr.setEncoding('utf8').on('data', (c: string) => take(c, 'err'))
      let settled = false
      const settle = (result: VerifyExecResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // The leader may exit while a grandchild still holds no pipe: sweep the group once more.
        if (timedOut || truncated) killGroup(child, 'SIGKILL')
        if (force) clearTimeout(force)
        resolveRun(result)
      }
      child.once('error', (err) => settle({ code: 1, stdout, stderr: `${stderr}spawn ${file} failed: ${err.message}` }))
      child.once('close', (code) => {
        if (timedOut || truncated) settle({ code: 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}), ...(truncated ? { truncated: true } : {}) })
        else settle({ code: code ?? 1, stdout, stderr })
      })
    })
}
