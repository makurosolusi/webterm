// Which canvas skills an agent node has attached (docs/decisions/skill-canvas-nodes.md): the skill nodes
// cabled to its `skills-in` in the STORED board, resolved against the live library. Pure over a board and a
// read-only skill lookup; the one place the server decides "attached", for the CLI gate and for awareness.
import type { Workspace } from '../shared/workspace'
import { isSkillHost, MAX_ATTACHED_SKILLS, SKILL_DESCRIPTION_MAX, SKILL_KIND } from '../shared/skillPorts'
import { canvasSees } from './central/contracts/skill.types'
import type { SkillAdminStore } from './central/skills/skillStore'

/** The read-only part of the skill store these lookups use. */
export type SkillLookup = Pick<SkillAdminStore, 'list' | 'descriptions'>

export type SkillState = { state: 'active'; version: string; description: string } | { state: 'disabled' } | { state: 'missing' }

const PAGE = 200

/** Live state of a canvas skill by name: `active` (switched on), `disabled` (off / hash mismatch) or `missing` (none, or a central one). */
export function skillState(skills: SkillLookup, name: string): SkillState {
  const rec = skills.list('active', { limit: PAGE }).find((r) => r.name === name && canvasSees(r.audience))
  if (rec) return rec.enabled === false ? { state: 'disabled' } : { state: 'active', version: rec.version, description: skills.descriptions().get(name) ?? '' }
  const off = skills.list('disabled', { limit: PAGE }).some((r) => r.name === name && canvasSees(r.audience))
  return off ? { state: 'disabled' } : { state: 'missing' }
}

/**
 * Skill names attached to `nodeId`, in cable order, distinct, at most MAX_ATTACHED_SKILLS: only bridges of kind
 * `skill` whose source is a skill node carrying a name and whose target is `nodeId` hosting skills. A cable with a
 * missing end attaches nothing.
 */
export function attachedSkillNames(ws: Pick<Workspace, 'nodes' | 'bridges'>, nodeId: string): string[] {
  const host = ws.nodes.find((n) => n.id === nodeId)
  if (!host || !isSkillHost(host)) return []
  const names: string[] = []
  for (const b of ws.bridges) {
    if (b.kind !== 'skill' || b.target !== nodeId) continue
    const n = ws.nodes.find((x) => x.id === b.source)
    if (n?.kind === SKILL_KIND && typeof n.skill === 'string' && !names.includes(n.skill)) names.push(n.skill)
  }
  return names.slice(0, MAX_ATTACHED_SKILLS)
}

export interface AttachedSkill { name: string; version: string; description: string }

/** Attached AND available (active, switched on) skills with the one-line description awareness quotes. */
export function attachedSkills(ws: Pick<Workspace, 'nodes' | 'bridges'>, nodeId: string, skills: SkillLookup | null): AttachedSkill[] {
  if (!skills) return []
  return attachedSkillNames(ws, nodeId).flatMap((name) => {
    const s = skillState(skills, name)
    return s.state === 'active' ? [{ name, version: s.version, description: oneLineDescription(s.description) }] : []
  })
}

/** One line, control characters flattened, cut at SKILL_DESCRIPTION_MAX: a description is data quoted to a model. */
export function oneLineDescription(s: string): string {
  const flat = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > SKILL_DESCRIPTION_MAX ? `${flat.slice(0, SKILL_DESCRIPTION_MAX)}…` : flat
}
