// Write-side actions of the Central Agent v2 control panel (WS-19). The transport has already
// authenticated the caller; `actor` is the derived identity, never a payload field.
import type { RouteResult } from '../apiShared.types'
import { redactSecrets } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { confirmPhrase } from './skills/skillLifecycle'
import { SkillError } from './skills/skillIndex'
import type { ToolResult } from './tools/toolTypes'

/** Actor prefix the skill admin steps require. */
export const HUMAN_PREFIX = 'human:'
const MAX_MESSAGE = 2000
const RELAY_TOOL = 'agent.relay'
const RELAY_TIER = 'R1'
const UI_CLOSE_REASON = 'closed_from_panel'
const CENTRAL_OWNER_PREFIX = 'central:'
const SKILL_STATUS: Readonly<Record<string, number>> = { forbidden: 403, not_found: 404, invalid: 400, limit: 409, hash_mismatch: 409 }

type Body = Record<string, unknown>
const fail = (status: number, error: string, extra: Body = {}): RouteResult => ({ status, body: { error, ...extra } })
const bodyOf = (raw: unknown): Body => (raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {})

/** Maps an executor result to a response; an approval requirement becomes `{approvalId}`. */
function fromTool(res: ToolResult): RouteResult {
  if (res.ok) return { status: 200, body: { status: 'done' } }
  const approvalId = (res.data as { approvalId?: unknown } | undefined)?.approvalId
  if (res.code === 'approval_required' && typeof approvalId === 'string') return { status: 200, body: { approvalId } }
  return fail(409, res.code ?? 'failed')
}

/** `POST /agents/:id/relay` — types a message into a live pty agent. */
export async function relayAgent(h: Ca2Handle, id: string, raw: unknown): Promise<RouteResult> {
  const message = bodyOf(raw).message
  if (!h.executor) return fail(404, 'agents_off')
  if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_MESSAGE) return fail(400, 'invalid_message')
  const agent = h.executor.store.get(id)
  if (!agent) return fail(404, 'agent_not_found')
  const gated = await h.executor.gate(agent.projectId, RELAY_TOOL, RELAY_TIER, !agent.owner.startsWith(CENTRAL_OWNER_PREFIX))
  if (gated) return fromTool(gated)
  return fromTool(await h.executor.prompt(agent, message, 'steer'))
}

/** `POST /agents/:id/close` — stops an agent; closing only reduces risk, so no approval is asked. */
export async function closeAgent(h: Ca2Handle, id: string): Promise<RouteResult> {
  if (!h.executor) return fail(404, 'agents_off')
  const agent = h.executor.store.get(id)
  if (!agent) return fail(404, 'agent_not_found')
  return fromTool(await h.executor.close(agent, UI_CLOSE_REASON, true))
}

/** Kill-switch side effect: force-closes every agent that has not ended. */
export async function closeAllAgents(h: Ca2Handle, reason: string): Promise<void> {
  if (!h.executor) return
  const rows = h.db.query('SELECT id FROM central_agents WHERE ended_at IS NULL').all() as Array<{ id: string }>
  for (const { id } of rows) {
    const agent = h.executor.store.get(id)
    if (agent) await h.executor.close(agent, redactSecrets(reason).slice(0, 100), true)
  }
}

function skillFailure(err: unknown): RouteResult {
  if (err instanceof SkillError) return fail(SKILL_STATUS[err.code] ?? 400, err.code, err.issues.length ? { issues: err.issues.map((i) => redactSecrets(i)).slice(0, 20) } : {})
  throw err
}

/** `POST /skills/:name/approve` and `/rollback`; both need a `human:*` actor. */
export function skillAction(h: Ca2Handle, name: string, action: 'approve' | 'rollback', raw: unknown, actor: string): RouteResult {
  if (!h.skills) return fail(404, 'skills_off')
  if (!actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  try {
    if (action === 'rollback') { h.skills.rollback(name, actor); return { status: 200, body: { status: 'done' } } }
    const version = bodyOf(raw).version
    if (typeof version !== 'string') return fail(400, 'invalid_version')
    h.skills.approve(name, version, actor, confirmPhrase(name, version))
    return { status: 200, body: { status: 'done' } }
  } catch (err) {
    return skillFailure(err)
  }
}
