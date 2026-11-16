import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow, type Row } from '../../ledger/ledgerCore'
import type { AgentKind, AgentOwner, AgentRecord, AgentRole, AgentRunner, AgentState } from '../contracts'
import { AGENT_TERMINAL_STATES } from '../contracts'
import { createLogger } from '../../logs'
import { AgentTransitionError, assertResumeFrom, assertTransition, isTerminalState } from './agentStateMachine'

const log = createLogger('central.agents')

const DEFAULT_PAGE = 50
const MAX_PAGE = 200
const PLACEHOLDERS = AGENT_TERMINAL_STATES.map(() => '?').join(',')

/** Idempotency key of a spawn: stable hash of its identifying parts (`projectId|itemId|planVersion|attempt` or a request id). */
export function agentReqId(...parts: ReadonlyArray<string | number>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export interface NewAgent {
  id: string
  projectId: string
  kind: AgentKind
  role: AgentRole
  runner: AgentRunner
  owner: AgentOwner
  reqId: string
  taskId?: string | null
  budgetJson?: string | null
}

export interface TransitionPatch {
  nodeId?: string
  approvalId?: string
  reason?: string
  /** Rejects the write when the stored fence differs (stale lease holder). */
  fence?: number
  /** Attempt number for the `rejected -> working` retry limit. */
  attempt?: number
}

export interface AgentListFilter { projectId: string; states?: readonly AgentState[]; limit?: number; offset?: number }

export interface AgentStore {
  create(input: NewAgent): AgentRecord
  get(id: string): AgentRecord | null
  getByReqId(reqId: string): AgentRecord | null
  /** Newest first; paginated (default 50, max 200). */
  list(filter: AgentListFilter): AgentRecord[]
  /** Non-terminal agents of every project, oldest first, for the boot reconciler. */
  listActive(limit?: number): AgentRecord[]
  /** Number of non-terminal agents; all projects when `projectId` is omitted. */
  countActive(projectId?: string): number
  /** Atomic compare-and-set move along a legal edge; throws `AgentTransitionError` otherwise. */
  transition(id: string, to: AgentState, patch?: TransitionPatch): AgentRecord
  /** Typed resume path only: `orphaned|session_exited -> working` after its PTY was relaunched with `--resume`; any other source state throws `illegal_transition`. */
  revive(id: string): AgentRecord
}

const endObservers = new WeakMap<Database, Set<(agent: AgentRecord) => void>>()

/** Calls `fn` after any agent on `db` reaches a terminal state (exit, spawn failure, cancel), so its work is settled by event, not a poll. */
export function onAgentEnded(db: Database, fn: (agent: AgentRecord) => void): () => void {
  const set = endObservers.get(db) ?? new Set()
  endObservers.set(db, set.add(fn))
  return () => { set.delete(fn) }
}

function publishEnded(db: Database, agent: AgentRecord): void {
  for (const fn of endObservers.get(db) ?? []) {
    try { fn(agent) } catch (err) {
      // The transition is committed; an observer failing must not turn it into a thrown spawn/exit.
      log.error('agent.end_observer_failed', `observer of agent ${agent.id} ending ${agent.state} failed`, { agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function toRecord(r: Row): AgentRecord {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v))
  return {
    id: String(r.id), projectId: String(r.project_id), nodeId: str(r.node_id), kind: String(r.kind), role: r.role as AgentRole,
    runner: r.runner as AgentRunner, taskId: str(r.task_id), fence: num(r.fence), state: r.state as AgentState,
    owner: r.owner as AgentOwner, approvalId: str(r.approval_id), budgetJson: str(r.budget_json), reqId: String(r.req_id),
    startedAt: Number(r.started_at), lastEventAt: num(r.last_event_at), endedAt: num(r.ended_at), endReason: str(r.end_reason),
  }
}

/** Repository over `central_agents`; every state change is validated against the state machine. */
export function createAgentStore(db: Database, now: () => number): AgentStore {
  const store: AgentStore = {
    create(input) {
      execWrite(db,
        `INSERT INTO central_agents (id, project_id, kind, role, runner, task_id, state, owner, req_id, budget_json, started_at, last_event_at)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`,
        input.id, input.projectId, input.kind, input.role, input.runner, input.taskId ?? null, input.owner, input.reqId, input.budgetJson ?? null, now(), now())
      return store.get(input.id) as AgentRecord
    },
    get: (id) => { const r = getRow(db, 'SELECT * FROM central_agents WHERE id = ?', id); return r ? toRecord(r) : null },
    getByReqId: (reqId) => { const r = getRow(db, 'SELECT * FROM central_agents WHERE req_id = ?', reqId); return r ? toRecord(r) : null },
    list({ projectId, states, limit, offset }) {
      const inStates = states?.length ? ` AND state IN (${states.map(() => '?').join(',')})` : ''
      const page = Math.min(MAX_PAGE, Math.max(1, Math.trunc(limit ?? DEFAULT_PAGE)))
      return allRows(db, `SELECT * FROM central_agents WHERE project_id = ?${inStates} ORDER BY started_at DESC, id LIMIT ? OFFSET ?`, projectId, ...(states ?? []), page, Math.max(0, Math.trunc(offset ?? 0))).map(toRecord)
    },
    listActive: (limit = MAX_PAGE) => allRows(db, `SELECT * FROM central_agents WHERE state NOT IN (${PLACEHOLDERS}) ORDER BY started_at, id LIMIT ?`, ...AGENT_TERMINAL_STATES, limit).map(toRecord),
    countActive(projectId) {
      const row = getRow(db, `SELECT COUNT(*) AS n FROM central_agents WHERE state NOT IN (${PLACEHOLDERS})${projectId ? ' AND project_id = ?' : ''}`, ...AGENT_TERMINAL_STATES, ...(projectId ? [projectId] : []))
      return Number(row?.n ?? 0)
    },
    transition(id, to, patch = {}) {
      const cur = store.get(id)
      if (!cur) throw new AgentTransitionError('agent_not_found', id, null, to)
      assertTransition(id, cur.state, to, patch.attempt)
      if (patch.fence !== undefined && patch.fence !== cur.fence) throw new AgentTransitionError('stale_fence', id, cur.state, to)
      const ended = isTerminalState(to)
      const changes = execWrite(db,
        `UPDATE central_agents SET state = ?, last_event_at = ?, node_id = COALESCE(?, node_id), approval_id = COALESCE(?, approval_id),
           ended_at = CASE WHEN ? THEN ? ELSE ended_at END, end_reason = COALESCE(?, end_reason) WHERE id = ? AND state = ?`,
        to, now(), patch.nodeId ?? null, patch.approvalId ?? null, ended ? 1 : 0, now(), patch.reason ?? null, id, cur.state)
      if (changes !== 1) throw new AgentTransitionError('concurrent_update', id, cur.state, to)
      const moved = store.get(id) as AgentRecord
      if (ended) publishEnded(db, moved)
      return moved
    },
    revive(id) {
      const cur = store.get(id)
      if (!cur) throw new AgentTransitionError('agent_not_found', id, null, 'working')
      assertResumeFrom(id, cur.state)
      const changes = execWrite(db, "UPDATE central_agents SET state = 'working', last_event_at = ?, ended_at = NULL, end_reason = NULL WHERE id = ? AND state = ?", now(), id, cur.state)
      if (changes !== 1) throw new AgentTransitionError('concurrent_update', id, cur.state, 'working')
      return store.get(id) as AgentRecord
    },
  }
  return store
}
