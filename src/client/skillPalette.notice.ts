// What every skill add tells the user: one notice (the app's VS Code style toast) per outcome, the same text whether the skill came from
// the palette, a drag, a drop on an agent, "Add to canvas" or a hand-drawn cable.
import type { Node } from '@xyflow/react'
import { MAX_ATTACHED_SKILLS } from '../shared/skillPorts'
import type { AddSkillResult } from './skillNode.add'
import { SP } from './skillPalette.labels'
import { showNotice } from './workspaceSave.notice'

/** One visible skill notice at a time: a newer outcome replaces the older one. */
export const SKILL_NOTICE_KEY = 'webterm-skill-palette'

/** What an agent is called in a notice: its title, else its agent id. */
export const hostName = (n: Node | undefined): string => {
  const d = n?.data as { title?: string; agentId?: string } | undefined
  return d?.title?.trim() || d?.agentId || 'agent'
}

/** Notice text and severity of an add outcome; `host` is the agent name when one was involved. */
export function addOutcome(r: AddSkillResult, host?: string): { title: string; severity: 'info' | 'warning' } {
  const agent = host ?? 'The selected agent'
  switch (r.status) {
    case 'no_board': return { title: SP.noBoard, severity: 'warning' }
    case 'attached': return { title: SP.attachedTo(agent), severity: 'info' }
    case 'limit': return { title: SP.full(agent, MAX_ATTACHED_SKILLS), severity: 'warning' }
    case 'exists': return { title: SP.exists(agent), severity: 'info' }
    default: return { title: SP.added, severity: 'info' }
  }
}

/** Tells the user how an add ended. */
export function reportSkillAdd(r: AddSkillResult, host?: string): void {
  showNotice(SKILL_NOTICE_KEY, addOutcome(r, host))
}

/** A hand-drawn skill cable that was not made: the agent is full, or this pair is already cabled. */
export function reportSkillRefused(why: 'exists' | 'limit', host: string): void {
  showNotice(SKILL_NOTICE_KEY, why === 'limit' ? { title: SP.refusedFull(host, MAX_ATTACHED_SKILLS), severity: 'warning' } : { title: SP.exists(host), severity: 'info' })
}
