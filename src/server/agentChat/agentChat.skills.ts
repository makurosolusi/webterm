// Awareness of attached canvas skills for an Agent Chat node (docs/decisions/skill-canvas-nodes.md): the chat twin of the
// terminal hook notice (skillAwareness.ts). The set itself comes from `attachedSkills` (skillAttach.ts: cap, truncation,
// active+enabled rules live there); this file only words it. Open = system prompt index, later turns = a visible note.
import { MAX_ATTACHED_SKILLS } from '../../shared/skillPorts'
import type { AttachedSkill } from '../skillAttach'

const HOW = 'Fetch the full instructions on demand with `webterm skills get <name>`; only these are available to you; they change when the user connects or disconnects skill nodes.'

/** System-prompt text listing the attached skills, or undefined when none are attached. */
export function attachedSkillsIndex(skills: readonly AttachedSkill[] | undefined): string | undefined {
  const list = (skills ?? []).slice(0, MAX_ATTACHED_SKILLS)
  if (!list.length) return undefined
  return `Skills attached to you (canvas skills): ${list.map((s) => `${s.name} v${s.version}: ${s.description || '(no description)'}`).join(' | ')}. ${HOW}`
}

/** Visible note prepended to a user turn when the attached set differs from the last announced one; undefined = unchanged. */
export function skillTurnNote(prev: readonly AttachedSkill[], now: readonly AttachedSkill[]): string | undefined {
  const before = new Map(prev.map((s) => [s.name, s]))
  const after = new Map(now.map((s) => [s.name, s]))
  const parts = [
    ...now.filter((s) => !before.has(s.name)).map((s) => `+${s.name}`),
    ...now.filter((s) => { const o = before.get(s.name); return !!o && (o.version !== s.version || o.description !== s.description) }).map((s) => `~${s.name} v${s.version}`),
    ...prev.filter((s) => !after.has(s.name)).map((s) => `-${s.name}`),
  ]
  return parts.length ? `[webterm] Skills attached: ${parts.join(' / ')}` : undefined
}
