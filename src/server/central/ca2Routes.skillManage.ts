// Human-only skill management routes: on/off switch, edit as a new version, duplicate. Each runs the same
// propose -> lint -> evaluate -> pending_approval lifecycle as any draft; none of them activates anything.
import type { RouteResult } from '../apiShared.types'
import { createLogger } from '../logs'
import type { Ca2Handle } from './ca2Boot'
import { HUMAN_PREFIX, badAudience, bodyOf, parseDraft, proposeHuman, skillFailure } from './ca2Routes.act'
import { FEATURE_OFF } from './ca2Routes.read'
import { isSkillAudience } from './contracts/skill.types'
import { SkillError, versionsOf } from './skills/skillIndex'

export type SkillManageAction = 'enable' | 'disable' | 'versions' | 'fork'
const log = createLogger('central.skills')
const fail = (status: number, error: string): RouteResult => ({ status, body: { error } })

/** `POST /skills/:name/(enable|disable|versions|fork)`; every one needs a `human:*` actor. */
export async function skillManage(h: Ca2Handle, name: string, action: SkillManageAction, raw: unknown, actor: string): Promise<RouteResult> {
  if (!h.skills) return fail(FEATURE_OFF, 'skills_off')
  if (!actor.startsWith(HUMAN_PREFIX)) return fail(403, 'human_only')
  try {
    if (action === 'enable' || action === 'disable') {
      h.skills.setEnabled(name, action === 'enable', actor)
      // Audit line like the approve/reject trail: who flipped which skill, never any content.
      log.info(`skills.${action}d`, `skill ${name} ${action}d`, { name, actor })
      return { status: 200, body: { status: 'done', enabled: action === 'enable' } }
    }
    if (action === 'fork') {
      const audience = bodyOf(raw).audience
      if (audience !== undefined && !isSkillAudience(audience)) return badAudience()
      const rec = await h.skills.fork(name, actor, audience)
      return { status: 201, body: { name: rec.name, version: rec.version, state: rec.status } }
    }
    // versions: an edit is a new version of an existing user skill; the store refuses builtin and a second open draft.
    if (versionsOf(h.db, name).length === 0) throw new SkillError('not_found', `skill ${name} not found`)
    const parsed = parseDraft(raw, name, versionsOf(h.db, name)[0].audience)
    return 'error' in parsed ? parsed.error : await proposeHuman(h, parsed.input, actor)
  } catch (err) {
    return skillFailure(err)
  }
}
