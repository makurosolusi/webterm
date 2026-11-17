// Agent-facing skill library: `webterm skills list|propose|edit` (capabilities `skills.list` / `skills.propose`).
// The caller is a proven agent node (`agent:<nodeId>`); it can only PROPOSE, through the same store path and the
// same boundary limits as every other draft. Approve / enable / disable / reject stay human-only
// (`skillAction` rejects any non-`human:` actor), and nothing here reaches them.
import type { RouteResult } from '../apiShared.types'
import { redactSecrets } from '../redactSecrets'
import type { Ca2Handle } from './ca2Boot'
import { FEATURE_OFF } from './ca2Routes.read'
import { type SkillStatus, canvasSees, isSkillAudience } from './contracts/skill.types'
import { badAudience } from './ca2Routes.act'
import { SkillError } from './skills/skillIndex'
import { skillState } from '../skillAttach'
import { MAX_BODY_CHARS, MAX_CAPS, MAX_DESCRIPTION, MAX_SKILL_NAME, SKILL_NAME_RE, validTitle } from './skills/skillLint'

export const AGENT_ACTOR_PREFIX = 'agent:'
const LIST_LIMIT = 200
const OPEN_STATES: readonly SkillStatus[] = ['proposed', 'evaluated', 'pending_approval']
const SKILL_STATUS: Readonly<Record<string, number>> = { audience_forbidden: 403, forbidden: 403, not_found: 404, invalid: 400, limit: 409, hash_mismatch: 409 }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RouteResult => ({ status, body: { error, ...extra } })
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max

/**
 * Library as an agent sees it: the enabled active canvas skills ATTACHED to its node (`attached`, from the cables of the
 * stored board, docs/decisions/skill-canvas-nodes.md) and the caller's own open drafts; never a central skill. `name`
 * adds that skill's body: an unattached canvas skill is 404 `not_attached`, an attached one that is off or gone 404
 * `unavailable`, anything else (central, unknown) 404 `not_found`. No `attached` = nothing attached.
 */
export function agentSkillList(h: Ca2Handle, nodeId: string, name?: string, attached: readonly string[] = []): RouteResult {
  if (!h.skills) return fail(FEATURE_OFF, 'skills_off')
  const described = h.skills.descriptions()
  const mine = `${AGENT_ACTOR_PREFIX}${nodeId}`
  const rows = [
    ...h.skills.list('active', { limit: LIST_LIMIT }).filter((r) => r.enabled !== false && canvasSees(r.audience) && attached.includes(r.name)),
    ...OPEN_STATES.flatMap((s) => h.skills?.list(s, { limit: LIST_LIMIT }) ?? []).filter((r) => r.proposedBy === mine),
  ]
  const items = rows.map((r) => ({ name: r.name, title: r.title || r.name, version: r.version, status: r.status, origin: r.origin, audience: r.audience, description: r.status === 'active' ? described.get(r.name) ?? '' : '', caps: r.caps }))
  if (name === undefined) return { status: 200, body: { items } }
  const state = skillState(h.skills, name)
  if (state.state === 'missing') return fail(404, 'not_found')
  if (!attached.includes(name)) return fail(404, state.state === 'active' ? 'not_attached' : 'not_found')
  const current = state.state === 'active' ? h.skills.load(name) : null
  if (!current) return fail(404, 'unavailable')
  return { status: 200, body: { items, skill: { name, version: current.record.version, audience: current.record.audience, description: described.get(name) ?? '', caps: current.record.caps, body: redactSecrets(current.body) } } }
}

/** `skills.propose`: validates the fields, then stores a draft as `agent:<nodeId>`; never activates. */
export async function agentSkillPropose(h: Ca2Handle, raw: Record<string, unknown>, nodeId: string): Promise<RouteResult> {
  if (!h.skills) return fail(FEATURE_OFF, 'skills_off')
  const { name } = raw
  if (typeof name !== 'string' || name.length > MAX_SKILL_NAME || !SKILL_NAME_RE.test(name)) return fail(400, 'invalid_name')
  let { title, description, body, caps = [], audience } = raw
  if (raw.edit === true) {
    const current = h.skills.load(name)
    if (!current) return fail(404, 'not_found')
    title ??= current.record.title
    description ??= h.skills.descriptions().get(name)
    body ??= current.body
    caps = raw.caps ?? current.record.caps
    if (!canvasSees(current.record.audience)) return fail(404, 'not_found') // a central skill is invisible to agents
    audience ??= current.record.audience
  }
  if (typeof title !== 'string' || !validTitle(title)) return fail(400, 'invalid_title')
  if (!isText(description, MAX_DESCRIPTION) || /[\r\n]/.test(description)) return fail(400, 'invalid_description')
  if (!isText(body, MAX_BODY_CHARS)) return fail(400, 'invalid_body')
  if (!Array.isArray(caps) || caps.length > MAX_CAPS || caps.some((c) => typeof c !== 'string')) return fail(400, 'invalid_caps')
  // A new proposal from an agent is forced to `canvas`; an explicit `central` is refused by the store (403 audience_forbidden).
  audience ??= 'canvas'
  if (!isSkillAudience(audience)) return badAudience()
  try {
    const rec = await h.skills.propose({ name, title, description, body, caps: caps as string[], audience }, `${AGENT_ACTOR_PREFIX}${nodeId}`)
    return { status: 201, body: { name: rec.name, version: rec.version, state: rec.status } }
  } catch (err) {
    if (!(err instanceof SkillError)) throw err
    return fail(SKILL_STATUS[err.code] ?? 400, err.code, err.issues.length ? { issues: err.issues.map((i) => redactSecrets(i)).slice(0, 20) } : {})
  }
}
