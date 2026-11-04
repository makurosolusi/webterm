// Mandatory completion verdict (F4-c, MAST "verification" failure modes). A task becomes `done` only
// from SYSTEM evidence: the diff the server saw, the lease it checked and the exit codes of commands
// it ran itself. What the worker said about its own work is kept for audit and never read here.
import type { Receipt } from '../capability/capability.receipt'
import { evidenceVerified } from '../orchestrator/orchestratorModel'
import type { VerifyOutcome } from '../orchestrator/verify'
import { toModelEvidence, type VerifyModelEvidence } from '../orchestrator/verifier'

export type CompletionReason = 'verified' | 'no_changes' | 'lease_violation' | 'verify_failed'

export interface CompletionVerdict {
  status: 'done' | 'failed'
  reason: CompletionReason
  /** One line for an error/outcome; never contains command output. */
  message: string
  /** Inbox/timeline line: `4 files, tests green ✓` or `failed: no changes`. */
  summary: string
  filesChanged: string[]
  /** Changed files outside the task's leased paths; non-empty means `lease_violation`. */
  leaseViolations: string[]
  /** Sealed model evidence: the only thing `evidenceVerified` accepts. */
  evidence: VerifyModelEvidence
  receipt: Receipt
}

export interface JudgeInput {
  taskId: string
  verdict: VerifyOutcome
  /** Code tasks must leave a diff; default true. */
  codeTask?: boolean
  /** The worker's own completion text. Recorded as ignored; it never changes the status. */
  claim?: string
}

const MAX_RECEIPT_FILES = 50

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function failure(verdict: VerifyOutcome, codeTask: boolean, evidence: VerifyModelEvidence): { reason: CompletionReason; message: string } | null {
  if (verdict.scopeViolations.length > 0) {
    return { reason: 'lease_violation', message: `lease violation: ${verdict.scopeViolations.slice(0, 5).join(', ')}` }
  }
  if (codeTask && verdict.changedFiles.length === 0) return { reason: 'no_changes', message: 'no changes' }
  if (!verdict.ok || !evidenceVerified(evidence)) {
    const reasons = verdict.reasons.length > 0 ? verdict.reasons : ['no machine evidence']
    return { reason: 'verify_failed', message: reasons.join('; ') }
  }
  return null
}

function doneSummary(verdict: VerifyOutcome): string {
  const parts = [plural(verdict.changedFiles.length, 'file'), 'tests green']
  if (verdict.typecheck?.ok) parts.push('typecheck green')
  return `${parts.join(', ')} ✓`
}

/** Judges a server verdict. Pure: no I/O, the caller records the receipt (`recordCompletion`). */
export function judgeCompletion(input: JudgeInput): CompletionVerdict {
  const { verdict } = input
  const evidence = toModelEvidence(verdict)
  const failed = failure(verdict, input.codeTask ?? true, evidence)
  const status = failed ? 'failed' : 'done'
  const reason = failed?.reason ?? 'verified'
  const message = failed?.message ?? 'verified'
  const receipt: Receipt = {
    outcome: failed ? 'denied' : 'ok',
    detail: reason,
    next: failed ? `fix: ${message}` : null,
    evidence: {
      filesChanged: verdict.changedFiles.length,
      files: verdict.changedFiles.slice(0, MAX_RECEIPT_FILES),
      diffStat: verdict.diffStat ?? '',
      leaseViolations: verdict.scopeViolations,
      commands: verdict.evidence.map((e) => ({ command: e.command, exitCode: e.exitCode, durationMs: e.durationMs, outputDigest: e.outputDigest })),
      ...(verdict.tests ? { tests: verdict.tests } : {}),
      ...(verdict.typecheck ? { typecheck: verdict.typecheck } : {}),
      // The claim is evidence of what the worker SAID, not of what happened: length only, never the text.
      workerClaim: { ignored: true, chars: input.claim?.length ?? 0 },
    },
    operationId: input.taskId,
  }
  return {
    status, reason, message,
    summary: failed ? `failed: ${message}` : doneSummary(verdict),
    filesChanged: verdict.changedFiles,
    leaseViolations: verdict.scopeViolations,
    evidence,
    receipt,
  }
}
