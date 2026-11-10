// Deterministic `project.brief` (RND/27 4.8): ledger + git facts -> pure attention rules -> JSON
// bounded at 800 tokens. The LLM only phrases it; nothing here calls a model or runs tests.
import type { Database } from 'bun:sqlite'
import type { BriefAttention, KnowledgeAnswer, KnowledgeHit, KnowledgeModule, KnowledgePort, ProjectBrief } from '../central/contracts/knowledge.types'
import { AGENT_TERMINAL_STATES } from '../central/contracts/agent.types'
import { estimateTokens } from '../central/tools/toolRegistry'
import { allRows, getRow } from '../ledger/ledgerCore'
import { ensureFresh, readGitState } from './knowledgeFresh'
import { moduleMap, searchKb } from './knowledgeMap'
import { KnowledgeError } from './knowledgeStore'

/** Hard cap of the serialized brief. */
export const BRIEF_MAX_TOKENS = 800
/** An agent waiting this long for input counts as blocked. */
export const AGENT_BLOCKED_MS = 10 * 60 * 1000
const MAX_EVIDENCE_CHARS = 160
const MAX_NEXT = 3
const LIST_LIMIT = 5

/** Facts the attention rules read; gathered once, so the rules stay pure. */
export interface BriefSnapshot {
  now: number
  name: string
  branch: string | null
  dirtyCount: number
  pendingApprovals: Array<{ id: string; kind: string }>
  failedTasks: Array<{ id: string; status: string }>
  blockedAgents: Array<{ id: string; waitedMs: number }>
  liveAgents: number
  readyTasks: number
  taskCounts: Record<string, number>
}

/** Pure rules in priority order; each returns zero or one attention entry. */
export function evaluateAttention(s: BriefSnapshot): BriefAttention[] {
  const out: BriefAttention[] = []
  if (s.pendingApprovals.length) out.push({ rule: 'approval_pending', evidence: `${s.pendingApprovals.length} pending: ${s.pendingApprovals.map((a) => `${a.id} (${a.kind})`).join(', ')}`, suggestedTool: 'approval.request' })
  if (s.failedTasks.length) out.push({ rule: 'task_failed', evidence: `${s.failedTasks.length} failed/blocked since last verified: ${s.failedTasks.map((t) => `${t.id} ${t.status}`).join(', ')}`, suggestedTool: 'task.status' })
  if (s.blockedAgents.length) out.push({ rule: 'agent_blocked', evidence: s.blockedAgents.map((a) => `${a.id} waiting ${Math.round(a.waitedMs / 60_000)} min`).join(', '), suggestedTool: 'agent.read' })
  if (s.dirtyCount > 0 && s.liveAgents === 0) out.push({ rule: 'dirty_no_agent', evidence: `${s.dirtyCount} uncommitted paths on ${s.branch ?? 'unknown branch'} with no running agent`, suggestedTool: 'project.read' })
  if (s.readyTasks > 0) out.push({ rule: 'task_ready', evidence: `${s.readyTasks} board tasks ready to assign`, suggestedTool: 'task.assign' })
  return out
}

function gather(db: Database, projectId: string, now: number, dirtyCount: number, branch: string | null): BriefSnapshot {
  const project = getRow(db, 'SELECT name FROM project WHERE id = ?', projectId)
  if (!project) throw new KnowledgeError('project_not_found', `project ${projectId} is not in the ledger`)
  const lastVerified = Number(getRow(db, "SELECT COALESCE(MAX(updated_at), 0) AS t FROM task WHERE project_id = ? AND status = 'verified'", projectId)?.t ?? 0)
  const terminal = AGENT_TERMINAL_STATES.map((st) => `'${st}'`).join(',')
  const taskCounts: Record<string, number> = {}
  for (const r of allRows(db, 'SELECT status, COUNT(*) AS c FROM task WHERE project_id = ? GROUP BY status', projectId)) taskCounts[String(r.status)] = Number(r.c)
  return {
    now, name: String(project.name), branch, dirtyCount, taskCounts,
    pendingApprovals: allRows(db, "SELECT id, kind FROM approval WHERE project_id = ? AND status = 'pending' ORDER BY created_at LIMIT ?", projectId, LIST_LIMIT).map((r) => ({ id: String(r.id), kind: String(r.kind) })),
    failedTasks: allRows(db, "SELECT id, status FROM task WHERE project_id = ? AND status IN ('failed','blocked') AND updated_at > ? ORDER BY updated_at DESC LIMIT ?", projectId, lastVerified, LIST_LIMIT).map((r) => ({ id: String(r.id), status: String(r.status) })),
    blockedAgents: allRows(db, "SELECT id, COALESCE(last_event_at, started_at) AS since FROM central_agents WHERE project_id = ? AND state = 'waiting_input' AND COALESCE(last_event_at, started_at) < ? ORDER BY since LIMIT ?", projectId, now - AGENT_BLOCKED_MS, LIST_LIMIT).map((r) => ({ id: String(r.id), waitedMs: now - Number(r.since) })),
    liveAgents: Number(getRow(db, `SELECT COUNT(*) AS c FROM central_agents WHERE project_id = ? AND state NOT IN (${terminal})`, projectId)?.c ?? 0),
    readyTasks: Number(getRow(db, "SELECT COUNT(*) AS c FROM central_task WHERE project_id = ? AND status = 'todo'", projectId)?.c ?? 0),
  }
}

function statusLine(s: BriefSnapshot): string {
  const tasks = Object.entries(s.taskCounts).sort().map(([k, v]) => `${v} ${k}`).join(', ') || 'no tasks'
  return `${s.name}: ${tasks}; branch ${s.branch ?? 'n/a'}${s.dirtyCount ? ` (${s.dirtyCount} dirty)` : ''}; ${s.liveAgents} live agents`
}

/** Shrinks a brief until its JSON fits `maxTokens`: shorter evidence first, then fewer attention entries. */
export function fitBrief(brief: ProjectBrief, maxTokens = BRIEF_MAX_TOKENS): ProjectBrief {
  let out: ProjectBrief = { ...brief, attention: brief.attention.map((a) => ({ ...a, evidence: a.evidence.slice(0, MAX_EVIDENCE_CHARS) })), next: brief.next.slice(0, MAX_NEXT) }
  while (estimateTokens(JSON.stringify(out)) > maxTokens && out.attention.length > 0) out = { ...out, attention: out.attention.slice(0, -1) }
  if (estimateTokens(JSON.stringify(out)) > maxTokens) out = { ...out, status: out.status.slice(0, MAX_EVIDENCE_CHARS), next: [] }
  return out
}

/** Builds the deterministic brief; `index` is stale when the knowledge cache lags git, `tests` when no verification postdates HEAD. */
export async function buildBrief(ledger: Database, kb: Database, projectId: string, root: string, now: number): Promise<ProjectBrief> {
  const git = await readGitState(root)
  const snap = gather(ledger, projectId, now, git.dirty.length, git.branch)
  const attention = evaluateAttention(snap)
  const fresh = await ensureFresh(kb, projectId, root, now, false)
  const lastVerified = Number(getRow(ledger, "SELECT COALESCE(MAX(updated_at), 0) AS t FROM task WHERE project_id = ? AND status = 'verified'", projectId)?.t ?? 0)
  const stale: string[] = []
  if (fresh.stale) stale.push('index')
  if (!git.isGit) stale.push('git')
  if (lastVerified === 0 || (git.commitTs !== null && git.commitTs > lastVerified)) stale.push('tests')
  return fitBrief({
    projectId, asOf: { at: now, ...(git.head ? { sha: git.head } : {}) }, status: statusLine(snap), attention,
    next: attention.map((a) => `${a.suggestedTool}: ${a.rule}`), stale,
  })
}

export interface KnowledgePortDeps { ledger: Database; kb: Database; now(): number }

/** `KnowledgePort` over the ledger and knowledge.db; the project root always comes from the ledger. */
export function createKnowledgePort(deps: KnowledgePortDeps): KnowledgePort {
  const rootOf = (projectId: string): string => {
    const row = getRow(deps.ledger, 'SELECT path FROM project WHERE id = ?', projectId)
    if (!row) throw new KnowledgeError('project_not_found', `project ${projectId} is not in the ledger`)
    return String(row.path)
  }
  return {
    brief: (projectId) => buildBrief(deps.ledger, deps.kb, projectId, rootOf(projectId), deps.now()),
    async search(projectId, query, limit): Promise<KnowledgeAnswer<readonly KnowledgeHit[]>> {
      const f = await ensureFresh(deps.kb, projectId, rootOf(projectId), deps.now())
      return { asOf: f.asOf, stale: f.stale, data: searchKb(deps.kb, projectId, query, limit) }
    },
    async map(projectId): Promise<KnowledgeAnswer<readonly KnowledgeModule[]>> {
      const f = await ensureFresh(deps.kb, projectId, rootOf(projectId), deps.now())
      return { asOf: f.asOf, stale: f.stale, data: moduleMap(deps.kb, projectId) }
    },
  }
}
