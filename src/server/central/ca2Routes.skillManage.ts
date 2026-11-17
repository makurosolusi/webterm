// Human-only skill management route: the on/off switch. Skills are written only by the author agents, so there is no
// human create, edit or duplicate route (docs/decisions/skill-approval.md).
import type { RouteResult } from '../apiShared.types'
import { createLogger } from '../logs'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX, skillFailure } from './ca2Routes.act'
import { FEATURE_OFF, pageOf } from './ca2Routes.read'
import { listSkillToggles, recordSkillToggle } from './skills/skillToggleAudit'

export type SkillManageAction = 'enable' | 'disable'
const log = createLogger('central.skills')
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })

/** `POST /skills/:name/(enable|disable)`; needs a `human:*` actor. */
export function skillManage(h: Ca2Handle, name: string, action: SkillManageAction, actor: string): RouteResult {
  if (!h.skills) return fail(FEATURE_OFF, 'skills_off')
  if (!actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  try {
    const toggle = h.skills.setEnabled(name, action === 'enable', actor)
    recordSkillToggle({ db: h.db, now: h.now }, toggle, actor)
    // Audit line like the approve/reject trail: who flipped which skill, never any content.
    log.info(`skills.${action}d`, `skill ${name} ${action}d`, { name, actor })
    return { status: 200, body: { status: 'done', enabled: action === 'enable' } }
  } catch (err) {
    return skillFailure(err)
  }
}

/** `GET /skills/audit?limit&offset`: newest-first on/off trail (who, which skill and version, from -> to, when). */
export function skillToggleAudit(h: Ca2Handle, q: URLSearchParams): RouteResult {
  if (!h.skills) return fail(FEATURE_OFF, 'skills_off')
  const page = pageOf(q)
  if (!page) return fail(400, 'invalid_page')
  return { status: 200, body: { items: listSkillToggles({ db: h.db, now: h.now }, page.limit, page.offset) } }
}
