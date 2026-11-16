// Picks a finished pty worker (and its browser) to hand a NEW task to instead of spawning another node. Pure policy over
// the ledger + injected ports (sessions, focus, browsers), so every refusal is testable and logged as one code.
import type { Database } from 'bun:sqlite'
import { allRows, execWrite, getRow } from '../../ledger/ledgerCore'
import { defaultTier } from '../../models/modelLadder'
import type { AgentRecord } from '../contracts'
import { type Complexity, storedPick } from './agentLadder'
import { createAgentStore } from './agentStore'

/**
 * Playbooks whose agents may take each other's tasks, by safety class (web research carries no private data, a review
 * is read-only). A playbook not listed here (code_change: its own worktree/branch) never reuses; unknown = spawn new.
 */
export const REUSE_CLASS: Readonly<Record<string, string>> = { web_research: 'web_research', review: 'review' }
/** guess: a context this many tasks deep starts to drag earlier work along; tune from observed result quality. */
export const MAX_REUSES = 3
/** guess: older than this the model context is mostly stale scrollback; tune with MAX_REUSES. */
export const MAX_AGE_MS = 3 * 60 * 60_000
/** Active agents examined per decision (the store's own page bound). */
const SCAN_MAX = 200
const SETTLED_TASK = ['needs_review', 'done']

/** What the process knows that the ledger does not; faked in tests, `agentReuse.ports.ts` in production. */
export interface ReusePorts {
  hasSession(nodeId: string): boolean
  /** Canvas node the user is looking at right now, or null. */
  focusedNode(): string | null
  /** Browser nodes cabled to this agent node. */
  cabledBrowsers(agentNodeId: string): string[]
  /** True while someone else drives the browser (human typing or another agent's lease). */
  browserBusy(browserNodeId: string): boolean
  /** Browser nodes of the project's board that no agent is cabled to, not busy. */
  idleBrowsers(db: Database, projectId: string): string[]
  /** Draws the agent<->browser cable (the canvas.edit `link`); false = refused. */
  link(agentNodeId: string, browserNodeId: string): boolean
}

export interface ReuseQuery { projectId: string; role: string; kind: string; complexity?: Complexity; playbookId: string }
export interface Rejection { agentId: string | null; reason: string }
export interface ReuseDecision {
  pick: { agentId: string; nodeId: string; reason: string } | null
  rejected: Rejection[]
}

interface Budget { reuse?: { count?: number } }
const budgetOf = (a: AgentRecord): Budget => { try { return JSON.parse(a.budgetJson ?? '{}') as Budget } catch { return {} } } // unreadable = no reuse recorded

/** Tasks this agent ever worked on: its spawn task plus every delegated follow-up. */
function tasksOf(db: Database, a: AgentRecord): string[] {
  const ids = allRows(db, 'SELECT task_id FROM central_assignment WHERE agent_id = ? ORDER BY started_at', a.id).map((r) => String(r.task_id))
  return [...new Set([...(a.taskId ? [a.taskId] : []), ...ids])]
}

/** First reason the agent cannot take the task, or null. Ordered cheap to costly; one code per refusal. */
function refusal(db: Database, ports: ReusePorts, q: ReuseQuery, a: AgentRecord, now: number): string | null {
  if (!a.owner.startsWith('central:')) return 'owner_not_central'
  if (a.projectId !== q.projectId) return 'project_mismatch'
  if (a.runner !== 'pty') return 'not_pty'
  if (a.role !== q.role || a.kind !== q.kind) return 'role_or_kind_mismatch'
  if (a.state !== 'candidate_done') return `state_${a.state}` // waiting_input = a question is still open: never reuse
  if (!a.nodeId) return 'no_node'
  if (!ports.hasSession(a.nodeId)) return 'session_gone'
  // Same decision the ladder makes for a fresh spawn; a budget cap or override that differs simply spawns new.
  if (storedPick(a)?.tier !== defaultTier('agent-spawn', q.complexity)) return 'tier_mismatch'
  if ((budgetOf(a).reuse?.count ?? 0) >= MAX_REUSES) return 'too_many_reuses'
  if (now - (a.startedAt ?? now) > MAX_AGE_MS) return 'too_old'
  const ran = allRows(db, "SELECT DISTINCT playbook FROM central_playbook_run WHERE json_extract(saved_json, '$.agent.agentId') = ?", a.id).map((r) => String(r.playbook))
  if (ran.length === 0 || ran.some((p) => REUSE_CLASS[p] !== REUSE_CLASS[q.playbookId])) return 'playbook_class_mismatch'
  const tasks = tasksOf(db, a)
  if (tasks.length === 0) return 'no_previous_task'
  for (const id of tasks) {
    if (!SETTLED_TASK.includes(String(getRow(db, 'SELECT status FROM central_task WHERE id = ?', id)?.status))) return 'task_not_settled'
    const sent = getRow(db, "SELECT 1 AS one FROM central_checkin_reason WHERE task_id = ? AND kind = 'task_report' AND sent_at IS NOT NULL LIMIT 1", id)
    const unsent = getRow(db, 'SELECT 1 AS one FROM central_checkin_reason WHERE task_id = ? AND sent_at IS NULL LIMIT 1', id)
    if (!sent || unsent) return 'result_not_delivered'
  }
  const focus = ports.focusedNode()
  const nodes = [a.nodeId, ...ports.cabledBrowsers(a.nodeId)]
  if ((focus !== null && nodes.includes(focus)) || ports.cabledBrowsers(a.nodeId).some((b) => ports.browserBusy(b))) return 'in_use'
  return null
}

/** The agent to hand `q` to, with every candidate's refusal; null pick = spawn a new one. */
export function pickReusableAgent(db: Database, ports: ReusePorts, q: ReuseQuery, now: () => number = Date.now): ReuseDecision {
  if (REUSE_CLASS[q.playbookId] === undefined) return { pick: null, rejected: [{ agentId: null, reason: 'playbook_not_reusable' }] }
  const rejected: Rejection[] = []
  const candidates = createAgentStore(db, now).listActive(SCAN_MAX).filter((a) => a.runner === 'pty').sort((x, y) => (y.lastEventAt ?? 0) - (x.lastEventAt ?? 0))
  for (const a of candidates) {
    const reason = refusal(db, ports, q, a, now())
    if (reason) { rejected.push({ agentId: a.id, reason }); continue }
    return { pick: { agentId: a.id, nodeId: a.nodeId as string, reason: `idle ${a.role} ${a.kind}, ${budgetOf(a).reuse?.count ?? 0}/${MAX_REUSES} reuses` }, rejected }
  }
  return { pick: null, rejected }
}

/** The browser to give the reused agent: its own cabled one, else an idle one of the board (re-cabled later), else none. */
export function pickReusableBrowser(db: Database, ports: ReusePorts, agentNodeId: string, projectId: string): { nodeId: string; mode: 'cabled' | 'rewire' } | null {
  const own = ports.cabledBrowsers(agentNodeId)[0]
  if (own !== undefined) return { nodeId: own, mode: 'cabled' }
  const idle = ports.idleBrowsers(db, projectId)[0]
  return idle === undefined ? null : { nodeId: idle, mode: 'rewire' }
}

/** Counts one more reuse on the agent row (`budget_json.reuse`, next to the ladder's keys; no schema change). */
export function markReused(db: Database, agentId: string, now: number): void {
  const row = getRow(db, 'SELECT budget_json FROM central_agents WHERE id = ?', agentId)
  let cur: Record<string, unknown> = {}
  try { cur = JSON.parse(String(row?.budget_json ?? '{}')) as Record<string, unknown> } catch { cur = {} } // unreadable budget: only the reuse note is kept
  const count = ((cur.reuse as { count?: number } | undefined)?.count ?? 0) + 1
  execWrite(db, 'UPDATE central_agents SET budget_json = ? WHERE id = ?', JSON.stringify({ ...cur, reuse: { count, lastAt: now } }), agentId)
}
