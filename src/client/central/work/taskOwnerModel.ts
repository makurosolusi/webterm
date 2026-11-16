import type { AssignmentView, TaskCard, WorkOwner, WorkStatus } from '../../../shared/centralWork'
import { TL } from './taskBoardLabels'

/** Longest result line shown on a card; the full line stays in the tooltip. */
export const RESULT_SUMMARY_MAX = 140
const MINUTE_MS = 60_000

/** Plain word for who holds a task. */
export const ownerLabel = (owner: WorkOwner): string => TL.owners[owner]

/** What happens next with an open task; null for a status nobody owns (todo, blocked, done, cancelled). */
export const nextStep = (task: Pick<TaskCard, 'status'>): string | null => (TL.nextSteps as Partial<Record<WorkStatus, string>>)[task.status] ?? null

// Time left rounds up (never "0m" before the deadline); time past rounds down (never overstates the delay).
function span(ms: number, round: (n: number) => number): string {
  const m = Math.max(1, round(ms / MINUTE_MS))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/** "Due in 4m" or "Overdue 2m"; null when there is no lease. */
export function leaseLabel(leaseUntil: number | null | undefined, now = Date.now()): string | null {
  if (typeof leaseUntil !== 'number') return null
  return leaseUntil > now ? TL.dueIn(span(leaseUntil - now, Math.ceil)) : TL.overdueBy(span(now - leaseUntil, Math.floor))
}

interface StoredResult { source: string; text?: unknown; resultLine?: unknown; reason?: unknown; failure?: { kind?: unknown } | null }
const asResult = (v: unknown): StoredResult | null =>
  typeof v === 'object' && v !== null && typeof (v as { source?: unknown }).source === 'string' ? v as StoredResult : null

const oneLine = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '')

/** The full one-line outcome of a stored worker result; null when it is not a worker result or has nothing to say. */
export function resultLine(result: unknown): string | null {
  const r = asResult(result)
  if (!r) return null
  if (r.failure) {
    const kind = typeof r.failure.kind === 'string' ? TL.failureKinds[r.failure.kind] : undefined
    return kind ? TL.interrupted(kind) : TL.interruptedPlain
  }
  const line = oneLine(r.resultLine) || oneLine(r.text)
  if (line) return line
  if (r.source !== 'none') return null
  const reason = oneLine(r.reason)
  return reason ? TL.noResultBecause(reason) : TL.noResult
}

/** One line of the worker result, cut to RESULT_SUMMARY_MAX; null when there is none. */
export function resultSummary(result: unknown): string | null {
  const line = resultLine(result)
  return line !== null && line.length > RESULT_SUMMARY_MAX ? `${line.slice(0, RESULT_SUMMARY_MAX - 1)}…` : line
}

export interface OwnerFacts {
  /** Who holds the task; null when it is not open or the server sent no owner. */
  owner: WorkOwner | null
  step: string | null
  /** "Due in 4m" / "Overdue 2m"; null while paused or without a lease. */
  lease: string | null
  overdue: boolean
  /** The connection is down and an agent owns the task: the server pauses the lease, so no signal age or overdue is shown. */
  paused: boolean
  /** Spoken form: "Owner Agent. Next: Agent is working." */
  aria: string | null
}

/** Everything the card and the detail say about who holds a task and what comes next (one source). */
export function ownerFacts(task: Pick<TaskCard, 'status' | 'owner'> & { assignment: AssignmentView | null }, now: number, linkDown: boolean): OwnerFacts {
  const owner = task.owner ?? null
  const step = owner ? nextStep(task) : null
  const paused = linkDown && owner === 'agent'
  const lease = owner && !paused ? leaseLabel(task.assignment?.leaseUntil, now) : null
  const until = task.assignment?.leaseUntil
  return { owner, step, lease, overdue: lease !== null && typeof until === 'number' && until <= now, paused, aria: owner && step ? TL.ownerAria(ownerLabel(owner), step) : null }
}
