// Canvas side of dragging a palette row: accept the drag, then on drop find the agent under the pointer (flow coordinates, via
// `screenToFlowPosition`) and hand the skill to the board's one add function. Landing on an agent cables it; elsewhere it is a bare node.
import type { DragEvent } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import type { AddSkillResult, AddSkillTarget, SkillRef } from './skillNode.add'
import { hasSkillDrag, readSkillDrag, skillHostAt } from './skillPalette.drag'
import { hostName, reportSkillAdd } from './skillPalette.notice'

type Add = (skill: SkillRef, target?: AddSkillTarget) => AddSkillResult

/** dragover: say a skill may be dropped (without this the browser refuses the drop). True when the drag is a skill. */
export function acceptSkillDrag(e: DragEvent): boolean {
  if (!hasSkillDrag(e.dataTransfer)) return false
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  return true
}

/** drop: true when the drop was a skill (handled here, with its notice); false leaves it to the other drop handlers. */
export function dropSkill(e: DragEvent, rf: ReactFlowInstance | null, nodes: readonly Node[], add: Add | undefined): boolean {
  if (!hasSkillDrag(e.dataTransfer)) return false
  e.preventDefault()
  const skill = readSkillDrag(e.dataTransfer)
  const at = rf?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
  if (!skill || !at) return true
  const host = skillHostAt(nodes, at)
  reportSkillAdd(add?.(skill, host ? { hostId: host.id } : { at }) ?? { status: 'no_board' }, host ? hostName(host) : undefined)
  return true
}
