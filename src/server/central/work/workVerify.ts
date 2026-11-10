import type { TaskView } from '../../../shared/centralWork'
import { createLogger } from '../../logs'
import { verifyWorktreeCompletion, type VerifyDirOptions } from '../../verifier/verifier.checks'
import type { CompletionVerdict } from '../../verifier/verifier.judge'
import { finishTask } from './workLifecycle'
import type { WorkActor, WorkStore } from './workModel'

const log = createLogger('central.work')
const RECOVER_PAGE = 200
const INTERRUPTED_REASON = 'verification was interrupted by a server restart'
const SYSTEM: WorkActor = { kind: 'system' }

/** Rule names of the verification path. */
export const WORK_VERIFY_RULES = { review: 'acceptance_review', start: 'verify_start', passed: 'verify_passed', failed: 'verify_failed', crashed: 'verify_crashed', autoDone: 'auto_done', interrupted: 'verifier_interrupted' } as const

export interface WorkVerifierDeps {
  store: WorkStore
  now(): number
  /** Working directory checks run in; null = the project has none (recorded as a crash). */
  cwdOf(projectId: string): string | null
  check?: (cwd: string, opts: VerifyDirOptions) => Promise<CompletionVerdict>
  /** Project switch for moving a passed task straight to done; default off. */
  autoDone?(projectId: string): boolean
}

export interface WorkVerifier {
  /** Starts acceptance of a `reported` task; resolves when its verdict landed or was dropped, never rejects. */
  run(taskId: string): Promise<void>
  /** Lands every `verifying` task this verifier is not running in needs_review; idempotent, never throws. */
  recoverInterrupted(): void
}

/** Verifier with at most one check per project at a time; a result for a task that moved on is dropped. */
export function createWorkVerifier({ store, now, cwdOf, check = verifyWorktreeCompletion, autoDone = () => false }: WorkVerifierDeps): WorkVerifier {
  const latest = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()
  let generation = 0

  const current = (taskId: string, run: number): boolean => latest.get(taskId) === run && store.getTask(taskId)?.status === 'verifying'
  const dropped = (taskId: string): void => log.info('work.verify_dropped', `verification result of task ${taskId} dropped: the task moved on`, { taskId })

  const land = (taskId: string, projectId: string, verdict: Record<string, unknown> & { passed: boolean }, rule: string, reason: string): void => {
    store.moveTask(taskId, 'needs_review', { actor: SYSTEM, rule, reason })
    store.setVerification(taskId, { ...verdict, at: now() })
    if (verdict.passed && autoDone(projectId)) finishTask(store, taskId, 'done', { actor: { kind: 'system', autoDone: true }, rule: WORK_VERIFY_RULES.autoDone, reason, endReason: WORK_VERIFY_RULES.autoDone })
  }

  const execute = async (taskId: string, projectId: string, lease: string[] | null, run: number): Promise<void> => {
    try {
      if (!current(taskId, run)) return dropped(taskId)
      let outcome: { verdict: CompletionVerdict } | { error: string }
      try {
        const cwd = cwdOf(projectId)
        if (!cwd) throw new Error(`project ${projectId} has no workspace directory`)
        outcome = { verdict: await check(cwd, { taskId, ...(lease ? { lease } : {}) }) }
      } catch (err) {
        outcome = { error: err instanceof Error ? err.message : String(err) }
      }
      if (!current(taskId, run)) return dropped(taskId)
      if ('error' in outcome) return land(taskId, projectId, { passed: false, error: outcome.error }, WORK_VERIFY_RULES.crashed, `verifier crashed: ${outcome.error}`)
      const { status, reason, message, summary, filesChanged, leaseViolations } = outcome.verdict
      const passed = status === 'done'
      land(taskId, projectId, { passed, status, reason, message, summary, filesChanged, leaseViolations }, passed ? WORK_VERIFY_RULES.passed : WORK_VERIFY_RULES.failed, summary)
    } catch (err) {
      log.error('work.verify_failed', `verification of task ${taskId} could not be recorded`, { taskId, projectId, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (latest.get(taskId) === run) latest.delete(taskId)
    }
  }

  return {
    async run(taskId) {
      try {
        const task = store.getTask(taskId)
        if (task?.status !== 'reported') return
        if (task.acceptance === 'review') { store.moveTask(taskId, 'needs_review', { actor: SYSTEM, rule: WORK_VERIFY_RULES.review }); return }
        store.moveTask(taskId, 'verifying', { actor: SYSTEM, rule: WORK_VERIFY_RULES.start })
        const run = ++generation
        latest.set(taskId, run)
        const turn = (queues.get(task.projectId) ?? Promise.resolve()).then(() => execute(taskId, task.projectId, task.boundaries, run))
        queues.set(task.projectId, turn)
        await turn
        if (queues.get(task.projectId) === turn) queues.delete(task.projectId)
      } catch (err) {
        log.error('work.verify_failed', `verification of task ${taskId} could not start`, { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    },
    recoverInterrupted() {
      const orphans: TaskView[] = []
      try {
        for (let offset = 0; ; offset += RECOVER_PAGE) {
          const page = store.listTasks({ statuses: ['verifying'], limit: RECOVER_PAGE, offset })
          orphans.push(...page.filter((task) => !latest.has(task.id)))
          if (page.length < RECOVER_PAGE) break
        }
      } catch (err) {
        log.error('work.verify_recover_failed', 'could not list tasks left in verifying', { error: err instanceof Error ? err.message : String(err) })
      }
      for (const task of orphans) {
        try {
          land(task.id, task.projectId, { passed: false, interrupted: true, error: INTERRUPTED_REASON }, WORK_VERIFY_RULES.interrupted, INTERRUPTED_REASON)
        } catch (err) {
          log.error('work.verify_recover_failed', `could not recover task ${task.id} from verifying`, { taskId: task.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
    },
  }
}
