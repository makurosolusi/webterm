// Vitest-only bridge: a real ledger (real `ledgerApproval` + `ledgerTask` code) over Node's
// in-memory SQLite. `migration.ts` imports `bun:sqlite` as a value, so this applies
// `MIGRATIONS` directly instead of calling `createLedger`; the task/approval modules it wires up
// are the production ones.
import type { Database } from 'bun:sqlite'
import type { LedgerContext } from './ledger/ledgerCore'
import type { Ledger } from './ledger/ledger'
import {
  consumeApproval,
  decideApproval,
  getApproval,
  listApprovals,
  requestApproval,
} from './ledger/ledgerApproval'
import { projectRepository } from './ledger/ledgerEntity'
import type { LedgerRuntime } from './ledger/ledgerRuntime'
import { MIGRATIONS } from './ledger/ledgerSchema'
import { claimDone, failTask, leaseTask, reopenTask, verifyTask } from './ledger/ledgerTask'
import { createTask, getTask } from './ledger/ledgerTaskCreate'
import { nodeSqlite } from './nodeSqlite.testutil'

export interface LedgerClock {
  at: number
}

export function memoryLedgerRuntime(at = 1_700_000_000_000): {
  runtime: LedgerRuntime
  clock: LedgerClock
} {
  const clock: LedgerClock = { at }
  const base = nodeSqlite().db
  // `ledgerCore.tx` joins an ambient transaction via bun:sqlite's `inTransaction` flag; the node
  // adapter has no such field, so track BEGIN/COMMIT here. Without it every nested tx() re-BEGINs.
  let depth = 0
  const db = {
    query: (sql: string) => base.query(sql),
    exec(sql: string) {
      base.exec(sql)
      const head = sql.trimStart().slice(0, 8).toUpperCase()
      if (head.startsWith('BEGIN')) depth += 1
      else if (head.startsWith('COMMIT') || head.startsWith('ROLLBACK')) {
        depth = Math.max(0, depth - 1)
      }
    },
    get inTransaction() {
      return depth > 0
    },
  } as unknown as Database
  for (const migration of MIGRATIONS) migration.up(db)
  const ctx: LedgerContext = { db, now: () => clock.at }
  const ledger = {
    project: projectRepository(ctx),
    approval: {
      requestApproval: (input: Parameters<typeof requestApproval>[1]) => requestApproval(ctx, input),
      getApproval: (id: string) => getApproval(ctx, id),
      decideApproval: (id: string, input: Parameters<typeof decideApproval>[2]) =>
        decideApproval(ctx, id, input),
      consumeApproval: (id: string, input: { digest: string; now?: number }) =>
        consumeApproval(ctx, id, input),
      listApprovals: (opts?: Parameters<typeof listApprovals>[1]) => listApprovals(ctx, opts),
    },
    task: {
      createTask: (input: Parameters<typeof createTask>[1]) => createTask(ctx, input),
      getTask: (id: string) => getTask(ctx, id),
      leaseTask: (id: string, input: Parameters<typeof leaseTask>[2]) => leaseTask(ctx, id, input),
      claimDone: (
        id: string,
        fence: number,
        evidence: unknown,
        opts?: Parameters<typeof claimDone>[4]
      ) => claimDone(ctx, id, fence, evidence, opts),
      verifyTask: (id: string, fence: number, evidence: unknown, opts?: Parameters<typeof verifyTask>[4]) =>
        verifyTask(ctx, id, fence, evidence, opts),
      failTask: (
        id: string,
        fence: number,
        reason: string,
        opts?: Parameters<typeof failTask>[4]
      ) => failTask(ctx, id, fence, reason, opts),
      reopenTask: (id: string, opts?: Parameters<typeof reopenTask>[2]) => reopenTask(ctx, id, opts),
    },
  } as unknown as Ledger
  const runtime: LedgerRuntime = { mode: 'on', path: ':memory:', db: db as Database, ledger, close() {} }
  return { runtime, clock }
}

/** A project plus a claimed_done task awaiting human review. */
export function seedReviewTask(
  runtime: LedgerRuntime,
  projectId = 'p1'
): { taskId: string; fence: number } {
  const started = runtime.ledger.task.createTask({ projectId, spec: 'review me' })
  const leased = runtime.ledger.task.leaseTask(started.id, { owner: 'worker', ttlMs: 60_000 })
  if (!leased) throw new Error('fixture: lease failed')
  const claimed = runtime.ledger.task.claimDone(
    started.id,
    leased.fence,
    { tests: 3 },
    { owner: 'worker' }
  )
  return { taskId: claimed.id, fence: claimed.fence }
}

export function seedProject(runtime: LedgerRuntime, projectId = 'p1'): void {
  runtime.ledger.project.createProject({
    id: projectId,
    workspaceId: `w-${projectId}`,
    name: projectId,
    path: `/tmp/${projectId}`,
  })
}
