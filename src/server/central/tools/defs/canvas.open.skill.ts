// canvas.open kind "skill" (docs/decisions/skill-canvas-nodes.md): the skill-specific parts, kept out of canvas.act.defs.ts
// (file health). A skill node is a REFERENCE to an active canvas skill; Central places it and may attach it in one call.
import { MAX_ATTACHED_SKILLS, SKILL_NODE_SIZE } from '../../../../shared/skillPorts'
import type { BridgeLink } from '../../../../shared/workspace'
import type { CanvasNode } from '../../../canvas/canvasPush'
import { skillState, type SkillLookup } from '../../../skillAttach'
import { MAX_SKILL_NAME, SKILL_NAME_RE } from '../../skills/skillLint'

export interface SkillRef { name: string; version: string }

/** True for a well-formed `skill` input: required (and a legal name) for kind skill, absent for every other kind. */
export function skillInputOk(kind: unknown, skill: unknown): boolean {
  return kind === 'skill' ? typeof skill === 'string' && skill.length <= MAX_SKILL_NAME && SKILL_NAME_RE.test(skill) : skill === undefined
}

/** The skill to reference, or the failure to report: Central skills off, or the name is not an active, switched-on canvas skill. */
export function resolveSkill(lib: SkillLookup | null, name: string): { ok: true; skill: SkillRef } | { ok: false; code: string; data: Record<string, unknown> } {
  if (!lib) return { ok: false, code: 'skills_off', data: { hint: 'Central skills are off in Settings; only the user can turn them on.' } }
  const state = skillState(lib, name)
  if (state.state !== 'active') {
    return { ok: false, code: 'skill_unavailable', data: { skill: name, state: state.state, hint: 'Only an active, switched-on canvas skill can be placed (see the Skills tab); central skills are never nodes.' } }
  }
  return { ok: true, skill: { name, version: state.version } }
}

/** The node the client builds (client skillNodeSpec): a collapsed card with the version seen now; x/y are placed by CanvasPush. */
export const skillNode = (base: { id: string; x: number; y: number; title?: string }, skill: SkillRef): CanvasNode =>
  ({ ...base, kind: 'skill', skill: skill.name, seenVersion: skill.version, collapsed: true, ...SKILL_NODE_SIZE })

/** True when `hostId` already holds the most skills one agent may have. */
export const skillCapReached = (bridges: readonly BridgeLink[], hostId: string): boolean =>
  bridges.filter((b) => b.kind === 'skill' && b.target === hostId).length >= MAX_ATTACHED_SKILLS

/** Cables skill -> agent (`skill-out` into `skills-in`), the id pattern of a drawn cable. */
export const skillCables = (nodes: readonly CanvasNode[], hostId: string): BridgeLink[] =>
  nodes.map((n) => ({ id: `bridge-${n.id}-${hostId}`, source: n.id, target: hostId, kind: 'skill' as const }))
