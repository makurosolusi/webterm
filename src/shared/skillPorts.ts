// Typed ports of the skill cable (docs/decisions/skill-canvas-nodes.md): one rule shared by the client
// (isValidConnection, canLink, onConnect, handle menu) and the server (canvas.edit, canvas.open, attach lookup).
import { hasClaudeHookSettings } from './workspace.capabilities'

/** Node kind of a canvas skill reference (`data.skill` = library skill name). */
export const SKILL_KIND = 'skill'
/** Source handle of a skill node and target handle of an agent (both typed `skill`). */
export const SKILL_OUT = 'skill-out'
export const SKILLS_IN = 'skills-in'
/** Most skills one agent may have attached; awareness and the server both stop here. */
export const MAX_ATTACHED_SKILLS = 8
/** A description is cut to this many characters (one line) in the awareness index. */
export const SKILL_DESCRIPTION_MAX = 160

/** Collapsed skill node = a round token of this size (client SkillToken.tsx); also the size Central gives one it places. */
export const SKILL_NODE_SIZE = { width: 80, height: 80 }
/** Expanded skill node (pill-radius card), the size it opens to until the user resizes it. */
export const SKILL_CARD_SIZE = { width: 260, height: 124 }

/** Just enough of a node to judge a cable. */
export interface PortEnd { id: string; kind?: string; agentId?: string }

/** True for a node that has a `skills-in` port: a Claude terminal agent or an agent chat. */
export function isSkillHost(n: Pick<PortEnd, 'kind' | 'agentId'>): boolean {
  if (n.kind === 'agentChat') return true
  return n.kind === 'agent' && !!n.agentId && hasClaudeHookSettings(n.agentId)
}

/**
 * Pair rule, order-free (the handle menu and canvas.edit ask without handles): `true` = a valid skill
 * cable, `false` = a skill node with anything else, `undefined` = no skill node involved (other rules apply).
 */
export function canSkillLink(a: PortEnd, b: PortEnd): boolean | undefined {
  const skills = (a.kind === SKILL_KIND ? 1 : 0) + (b.kind === SKILL_KIND ? 1 : 0)
  if (skills === 0) return undefined
  if (skills === 2 || a.id === b.id) return false
  return isSkillHost(a.kind === SKILL_KIND ? b : a)
}

/**
 * Drawn connection with its handles: `undefined` = not a skill connection (regular rules), `true` only for
 * `skill-out` of a skill node into `skills-in` of a host. Any other use of either port is refused.
 */
export function skillConnection(src: PortEnd, srcHandle: string | null | undefined, dst: PortEnd, dstHandle: string | null | undefined): boolean | undefined {
  const touches = src.kind === SKILL_KIND || dst.kind === SKILL_KIND || srcHandle === SKILL_OUT || dstHandle === SKILLS_IN
  if (!touches) return undefined
  return src.kind === SKILL_KIND && srcHandle === SKILL_OUT && dstHandle === SKILLS_IN && isSkillHost(dst)
}
