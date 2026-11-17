// Pure rules of a skill node card: what a reference to a library skill shows, from the live library.
// active = on and canvas; disabled = switched off; missing = no canvas skill of that name. Nothing is ever deleted
// for being unavailable: the node and its cable stay, the attachment just has no effect (docs/decisions/skill-canvas-nodes.md).
import type { CanvasSkill, CanvasSkillsLoad } from './skillNode.api'

export type SkillCardState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'off' }
  | { kind: 'active'; version: string; description: string }
  | { kind: 'disabled' }
  | { kind: 'missing' }

/** The card state of the skill `name` given what the library lookup returned. */
export function cardState(load: CanvasSkillsLoad, name: string | undefined): SkillCardState {
  if (load.status !== 'ready') return { kind: load.status }
  const hit = name ? load.skills.find((s) => s.name === name) : undefined
  if (!hit) return { kind: 'missing' }
  return hit.enabled ? { kind: 'active', version: hit.version, description: hit.description } : { kind: 'disabled' }
}

/** Unavailable = the attachment has no effect right now (disabled or missing). */
export const isUnavailable = (s: SkillCardState): boolean => s.kind === 'disabled' || s.kind === 'missing'

/** True when the active version moved on since the node recorded the one it saw. */
export const versionChanged = (seen: string | undefined, current: string): boolean => !!seen && !!current && seen !== current

/** Skills the pickers offer: active and switched on, matching the spawn menu's own sort (name). */
export const attachable = (skills: readonly CanvasSkill[]): CanvasSkill[] => skills.filter((s) => s.enabled).sort((a, b) => a.name.localeCompare(b.name))
