// Real processes behind ProblemsService (child_process; kept apart so the service stays testable).
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { recordEvent } from '../events/producers'
import { ptyEnv } from '../ptyShell'
import type { ProblemsDeps } from './problems.service'

const MAX_BUFFER = 16 * 1024 * 1024

export function productionProblemsDeps(): ProblemsDeps {
  // `ptyEnv` strips webterm's own secrets (root token) from what a workspace tool inherits.
  const env = (): NodeJS.ProcessEnv => ({ ...ptyEnv(process.env, { interactive: false }), FORCE_COLOR: '0' })
  return {
    spawn(bin, args, cwd) {
      const p = spawn(bin, args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
      p.stdout.setEncoding('utf8')
      return {
        onStdout: (cb) => { p.stdout.on('data', cb) },
        onExit: (cb) => { p.on('exit', cb); p.on('error', () => cb(-1)) },
        kill: () => { p.kill() },
      }
    },
    exec: (bin, args, cwd, timeoutMs) => new Promise((resolve, reject) => {
      execFile(bin, args, { cwd, env: env(), timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
        // Non-zero exit with JSON on stdout = problems found, a normal answer.
        if (stdout.trim()) return resolve(stdout)
        reject(new Error(err ? `${err.message}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}` : 'no output'))
      })
    }),
    exists: existsSync,
    record: recordEvent,
  }
}
