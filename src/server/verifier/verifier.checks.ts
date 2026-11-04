// Which checks the verifier runs for a worktree, from the project's own scripts (F4-c). A repo with
// no `typecheck` script is not failed for lacking one; a repo with no `test` script yields no test
// evidence, so a code task there can never verify (`evidenceVerified` needs passing tests).
// The commands themselves stay the server-owned argv in `verifyCommands.ts`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckId } from '../orchestrator/verifyCommands'
import { verifyWorktree } from '../orchestrator/verify'
import { createProcessExec } from '../orchestrator/verifier'
import { judgeCompletion, type CompletionVerdict } from './verifier.judge'

/** Checks backed by a `package.json` script; undefined when there is no readable package.json. */
export function projectChecks(cwd: string): Partial<Record<CheckId, boolean>> | undefined {
  let scripts: Record<string, unknown>
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    scripts = pkg.scripts ?? {}
  } catch {
    return undefined
  }
  const has = (name: string) => typeof scripts[name] === 'string'
  return { test: has('test'), typecheck: has('typecheck'), lint: false }
}

export interface VerifyDirOptions {
  taskId: string
  /** Leased paths (DAG lease / plan scope); empty = the whole worktree. */
  lease?: readonly string[]
  baseRef?: string
  claim?: string
  timeoutMs?: number
}

/** Verifies a worktree end to end (git diff + project scripts with timeouts) and judges it. */
export async function verifyWorktreeCompletion(cwd: string, opts: VerifyDirOptions): Promise<CompletionVerdict> {
  const checks = projectChecks(cwd)
  const verdict = await verifyWorktree(
    { root: cwd, exec: createProcessExec(), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) },
    { cwd, ...(opts.lease ? { scope: opts.lease } : {}), ...(opts.baseRef ? { baseRef: opts.baseRef } : {}), ...(checks ? { checks } : {}) },
  )
  return judgeCompletion({ taskId: opts.taskId, verdict, ...(opts.claim !== undefined ? { claim: opts.claim } : {}) })
}
