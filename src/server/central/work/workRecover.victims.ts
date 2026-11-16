// Who an outage or a rate limit hurt, found from data that already exists (no schema of its own): open attempts whose
// StopFailure was recorded as `work.interrupted`, attempts that ended as vanished/stalled/failed inside the window,
// and check-in reasons that were sent but whose turn died on the network.
import type { Database } from 'bun:sqlite'
import type { AssignmentView, WorkStatus } from '../../../shared/centralWork'
import { allRows, getRow, parseJson } from '../../ledger/ledgerCore'
import type { FailureKind } from './workFailureKind'
import type { WorkStore } from './workModel'
import { INTERRUPTED_EVENT } from './workWatcher'
import { RECOVER_EVENT, REQUEUE_EVENT, type SweepKey, type Victim } from './workRecover.model'

const OPEN: readonly WorkStatus[] = ['assigned', 'running', 'waiting_input', 'stalled']
/** End reasons that mean "the session was lost", not "the agent finished badly" (workSupervisor / workWatcher / agent exits). */
const LOST_SESSION = /^(vanish|restart_limit|stalled|agent_|session_end)/
/** The attempt was ended on purpose (a person or Central closed it): never brought back. */
const CLOSED_ON_PURPOSE: readonly string[] = ['cancelled', 'killed', 'closed', 'accepted', 'closing']
const KINDS: readonly string[] = ['network', 'rate_limited', 'overloaded', 'server', 'auth', 'permanent', 'unknown']

const asKind = (v: unknown): FailureKind | null => (typeof v === 'string' && KINDS.includes(v) ? (v as FailureKind) : null)

/** The class StopFailure stored on the attempt's result, if any. */
const resultKind = (a: AssignmentView): FailureKind | null => asKind((a.result as { failure?: { kind?: unknown } } | null)?.failure?.kind)

const inWindow = (at: number, { window }: SweepKey): boolean => at >= window.from && at <= window.to

/** Keeps a victim only when the key's class filter allows it: a rate-limit sweep never touches network casualties. */
const allowed = (kind: FailureKind, key: SweepKey): boolean => key.only === undefined || kind === key.only

export interface VictimDeps { db: Database; store: WorkStore; agentState(agentId: string): string | null }

function openVictims({ db, store, agentState }: VictimDeps, key: SweepKey): Victim[] {
  const interrupted = new Map<string, { kind: FailureKind; at: number }>()
  for (const r of allRows(db, 'SELECT ts, payload_json FROM event WHERE kind = ? AND ts >= ? AND ts <= ? ORDER BY seq', INTERRUPTED_EVENT, key.window.from, key.window.to)) {
    const p = (parseJson(r.payload_json) ?? {}) as { assignmentId?: unknown; reason?: unknown }
    const kind = asKind(p.reason)
    if (typeof p.assignmentId === 'string' && kind) interrupted.set(p.assignmentId, { kind, at: Number(r.ts) })
  }
  const out: Victim[] = []
  for (const a of store.openAssignments()) {
    const task = store.getTask(a.taskId)
    if (!task || !OPEN.includes(task.status)) continue
    const hit = interrupted.get(a.id)
    // A task that went `stalled` inside the window without a recorded class was cut off by the link (the lease ran while the detector was still deciding).
    const stalledInside = hit === undefined && task.status === 'stalled' && inWindow(task.updatedAt, key)
    const kind = hit?.kind ?? (stalledInside ? resultKind(a) ?? 'network' : null)
    if (!kind || !allowed(kind, key)) continue
    if (a.agentId && CLOSED_ON_PURPOSE.includes(agentState(a.agentId) ?? '')) continue
    out.push({ task, assignment: a, kind, ended: false, at: hit?.at ?? task.updatedAt })
  }
  return out
}

function endedVictims({ db, store, agentState }: VictimDeps, key: SweepKey): Victim[] {
  const out: Victim[] = []
  for (const r of allRows(db, "SELECT id FROM central_task WHERE status = 'failed' AND updated_at >= ? AND updated_at <= ? ORDER BY updated_at LIMIT 200", key.window.from, key.window.to)) {
    const task = store.getTask(String(r.id))
    const a = task ? store.assignmentsOfTask(task.id, 1)[0] : undefined
    if (!task || !a || a.endedAt === null || !LOST_SESSION.test(a.endReason ?? '') || !inWindow(a.endedAt, key)) continue
    if (a.agentId && CLOSED_ON_PURPOSE.includes(agentState(a.agentId) ?? '')) continue
    const kind = resultKind(a) ?? (key.only ? null : 'network')
    if (!kind || !allowed(kind, key)) continue
    out.push({ task, assignment: a, kind, ended: true, at: a.endedAt })
  }
  return out
}

/** Kind carried by the error part of the turn's assistant message (claudeFailure puts it there), else the code `interrupted` of a restart. */
function turnKind(db: Database, turnId: string, errorCode: unknown): FailureKind | null {
  const row = getRow(db, "SELECT parts_json FROM central_message WHERE turn_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1", turnId)
  const parts = (parseJson(row?.parts_json) ?? []) as { type?: unknown; kind?: unknown }[]
  const fromPart = asKind(parts.find((p) => p.type === 'error')?.kind)
  return fromPart ?? (errorCode === 'interrupted' ? 'network' : null)
}

/** Reasons whose check-in turn failed with no task move afterwards: the wake was spent and lost. */
function checkinVictims({ db, store }: VictimDeps, key: SweepKey): Victim[] {
  const out: Victim[] = []
  const rows = allRows(db, `SELECT r.id, r.task_id, r.sent_at, t.error_code, t.id AS turn_id FROM central_checkin_reason r JOIN central_turn t ON t.id = r.turn_id
    WHERE r.sent_at IS NOT NULL AND r.task_id IS NOT NULL AND t.status = 'failed' AND t.ended_at >= ? AND t.ended_at <= ?
    AND NOT EXISTS (SELECT 1 FROM event e WHERE e.correlation_id = r.task_id AND e.kind LIKE 'work.task.%' AND e.ts > r.sent_at) LIMIT 200`, key.window.from, key.window.to)
  for (const r of rows) {
    const kind = turnKind(db, String(r.turn_id), r.error_code)
    const task = store.getTask(String(r.task_id))
    const a = task ? store.assignmentsOfTask(task.id, 1)[0] : undefined
    if (!kind || !task || !a || !allowed(kind, key)) continue
    out.push({ task, assignment: a, kind, ended: a.endedAt !== null, at: Number(r.sent_at), reasonId: String(r.id) })
  }
  return out
}

/** Every victim of `key`, newest-independent; one task can appear twice (its attempt and its lost wake) and is merged by the caller. */
export function findVictims(deps: VictimDeps, key: SweepKey): Victim[] {
  return [...openVictims(deps, key), ...endedVictims(deps, key), ...checkinVictims(deps, key)]
}

/** Tasks that already reached a final outcome (recovered or escalated) under `key`: they are not looked at again. */
export function settledTasks(db: Database, key: string): Set<string> {
  const rows = allRows(db, `SELECT DISTINCT correlation_id AS id FROM event WHERE kind = ? AND json_extract(payload_json, '$.episode') = ?
    AND json_extract(payload_json, '$.outcome') IN ('recovered', 'escalated') AND correlation_id IS NOT NULL`, RECOVER_EVENT, key)
  return new Set(rows.map((r) => String(r.id)))
}

/** How many times a rung was tried for `taskId` under `key` (failed tries count: the limit bounds effort, not success). */
export function rungAttempts(db: Database, taskId: string, key: string, rung: number): number {
  return Number(getRow(db, `SELECT COUNT(*) AS n FROM event WHERE kind = ? AND correlation_id = ? AND json_extract(payload_json, '$.episode') = ?
    AND json_extract(payload_json, '$.rung') = ? AND json_extract(payload_json, '$.acted') = 1`, RECOVER_EVENT, taskId, key, rung)?.n ?? 0)
}

/** How often this reason was queued again (all episodes: a reason is retried three times in its life). */
export function requeueCount(db: Database, reasonId: string): number {
  return Number(getRow(db, "SELECT COUNT(*) AS n FROM event WHERE kind = ? AND json_extract(payload_json, '$.reasonId') = ?", REQUEUE_EVENT, reasonId)?.n ?? 0)
}
