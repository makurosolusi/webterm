// The model ladder for Central workers (PTY and headless alike): one decision per agent, kept on its row so a
// resume relaunches on the same model, and a re-spawn after a failed check climbs a rung (`pickModel` escalation).
import type { Database } from 'bun:sqlite'
import { allRows, execWrite } from '../../ledger/ledgerCore'
import type { ModelPick, ResolveInput } from '../../models/modelLadder'
import { pickModel } from '../../models/modelPick'
import type { AgentRecord } from '../contracts'

/** How hard Central says the worker's task is; the ladder maps it to a start tier (`defaultTier`). */
export type Complexity = NonNullable<ResolveInput['complexity']>
export const COMPLEXITIES: readonly Complexity[] = ['simple', 'moderate', 'complex']

type StoredPick = Pick<ModelPick, 'model' | 'effort' | 'tier' | 'reason'>
interface LadderMeta { complexity?: Complexity; pick?: StoredPick }

// `central_agents.budget_json` holds no per-agent budget today; the ladder decision lives under its `ladder` key (no schema change).
function metaOf(budgetJson: string | null): LadderMeta {
  try {
    const m = (JSON.parse(budgetJson ?? '{}') as { ladder?: LadderMeta }).ladder
    return m && typeof m === 'object' ? m : {}
  } catch { return {} } // an unreadable column is "no decision yet": the ladder decides again
}

/** `budget_json` for a new agent: only the stated complexity (the pick is made at launch). */
export const ladderJson = (complexity?: Complexity): string | null => (complexity ? JSON.stringify({ ladder: { complexity } }) : null)

/** The pick this agent already launched with, or null (never launched, or started before the ladder reached PTY). */
export function storedPick(agent: Pick<AgentRecord, 'budgetJson'>): ModelPick | null {
  const p = metaOf(agent.budgetJson).pick
  return p ? { model: p.model, effort: p.effort, tier: p.tier, reason: p.reason } : null
}

/** Verify failures of earlier agents on the same task (oldest first) and the complexity the latest one ran with. */
function history(db: Database, agent: AgentRecord): { failures: NonNullable<ResolveInput['lastFailure']>[]; complexity?: Complexity } {
  if (!agent.taskId) return { failures: [] }
  const rows = allRows(db, "SELECT end_reason, budget_json FROM central_agents WHERE task_id = ? AND id != ? AND state = 'rejected' ORDER BY ended_at, id", agent.taskId, agent.id)
  const failures = rows.map((r) => String(r.end_reason)).filter((r): r is 'verify_failed' | 'no_changes' => r === 'verify_failed' || r === 'no_changes')
  const last = rows.length ? metaOf(rows[rows.length - 1]?.budget_json as string | null).complexity : undefined
  return { failures, ...(last ? { complexity: last } : {}) }
}

/**
 * The model of `agent`: its stored decision when it has one (resume, re-open), else a fresh `pickModel` for
 * kind `agent-spawn` (override, grant, budget and escalation after earlier failed checks all apply), stored on the row.
 */
export function pickForAgent(db: Database, agent: AgentRecord, now: () => number): ModelPick {
  const kept = storedPick(agent)
  if (kept) return kept
  const meta = metaOf(agent.budgetJson)
  const past = history(db, agent)
  const complexity = meta.complexity ?? past.complexity
  const pick = pickModel(db, {
    kind: 'agent-spawn', projectId: agent.projectId, runRef: `agent:${agent.id}`, ...(complexity ? { complexity } : {}),
    attempt: past.failures.length, lastFailure: past.failures[past.failures.length - 1] ?? null,
  }, now)
  const json = JSON.stringify({ ladder: { ...(complexity ? { complexity } : {}), pick: { model: pick.model, effort: pick.effort, tier: pick.tier, reason: pick.reason } } })
  execWrite(db, 'UPDATE central_agents SET budget_json = ? WHERE id = ?', json, agent.id)
  return pick
}
