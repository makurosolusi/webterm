// Drag of a palette row onto the canvas: a private MIME carrying the skill reference, and the hit-test that
// decides which agent (if any) the drop landed on. Pure, so the geometry is testable without a browser.
import type { Node, XYPosition } from '@xyflow/react'
import type { AgentId } from '../shared/workspace'
import { isSkillHost } from '../shared/skillPorts'
import type { SkillRef } from './skillNode.add'

export const SKILL_DRAG_MIME = 'application/x-webterm-skill'

/** Puts the skill on the drag; the canvas reads it back on drop. */
export function setSkillDrag(dt: Pick<DataTransfer, 'setData' | 'effectAllowed'>, skill: SkillRef): void {
  dt.setData(SKILL_DRAG_MIME, JSON.stringify(skill))
  dt.effectAllowed = 'copy'
}

export const hasSkillDrag = (dt: Pick<DataTransfer, 'types'>): boolean => Array.from(dt.types).includes(SKILL_DRAG_MIME)

/** The dragged skill, or null when the payload is absent or malformed. */
export function readSkillDrag(dt: Pick<DataTransfer, 'getData'>): SkillRef | null {
  try {
    const o = JSON.parse(dt.getData(SKILL_DRAG_MIME)) as { name?: unknown; version?: unknown } | null
    return typeof o?.name === 'string' && o.name && typeof o.version === 'string' ? { name: o.name, version: o.version } : null
  } catch {
    // Not our payload (empty or foreign text): the drop is simply not a skill.
    return null
  }
}

/** The agent under the flow point `at` that takes skills; the topmost node wins (later nodes draw on top), so a node covering an agent hides it. */
export function skillHostAt(nodes: readonly Node[], at: XYPosition): Node | undefined {
  const top = [...nodes].reverse().find((n) => {
    const w = n.measured?.width ?? n.width ?? 0
    const h = n.measured?.height ?? n.height ?? 0
    return at.x >= n.position.x && at.x <= n.position.x + w && at.y >= n.position.y && at.y <= n.position.y + h
  })
  return top && isSkillHost({ kind: top.type, agentId: (top.data as { agentId?: AgentId } | undefined)?.agentId }) ? top : undefined
}
