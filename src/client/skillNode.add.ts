// Pure helpers behind "add a skill node": what the node is, which agent a new one should be cabled to, and the
// cable itself. The board wiring (state, save) is in App.board.ts; the typed-port rule is `shared/skillPorts`.
import type { Edge, Node } from '@xyflow/react'
import { isSkillHost, MAX_ATTACHED_SKILLS, SKILL_KIND, SKILL_NODE_SIZE } from '../shared/skillPorts'
import type { AgentId, WsNode } from '../shared/workspace'
import { toFlowEdge } from './store'

/** A library skill as the pickers hand it over: name + the active version seen now. */
export interface SkillRef { name: string; version: string }

/** Outcome of "Add to canvas" (SkillDetail): on the board, and whether it was cabled to the selected agent. */
export type AddSkillResult = { status: 'no_board' } | { status: 'added' } | { status: 'attached' } | { status: 'limit' }

/** The node a skill reference becomes: collapsed card size, `seenVersion` recorded so only a later change reads "Updated". */
export const skillNodeSpec = (id: string, s: SkillRef): Omit<WsNode, 'x' | 'y'> =>
  ({ id, kind: SKILL_KIND, skill: s.name, seenVersion: s.version, collapsed: true, ...SKILL_NODE_SIZE })

/** The one selected agent that takes skills, or undefined when none or several are selected. */
export function selectedSkillHost(nodes: readonly Node[]): Node | undefined {
  const picked = nodes.filter((n) => n.selected)
  const [only] = picked
  return picked.length === 1 && isSkillHost({ kind: only.type, agentId: (only.data as { agentId?: AgentId } | undefined)?.agentId }) ? only : undefined
}

const isSkillEdge = (e: Edge): boolean => (e.data as { kind?: string } | undefined)?.kind === 'skill'

/** Skills already cabled to `hostId`. */
export const attachedCount = (edges: readonly Edge[], hostId: string): number => edges.filter((e) => e.target === hostId && isSkillEdge(e)).length

/** The skill cable skill -> host, or why not: this pair is already cabled, or the host holds MAX_ATTACHED_SKILLS. */
export function skillCable(edges: readonly Edge[], skillId: string, hostId: string): { edge: Edge } | { refused: 'exists' | 'limit' } {
  if (edges.some((e) => e.source === skillId && e.target === hostId)) return { refused: 'exists' }
  if (attachedCount(edges, hostId) >= MAX_ATTACHED_SKILLS) return { refused: 'limit' }
  return { edge: toFlowEdge({ id: `bridge-${skillId}-${hostId}`, source: skillId, target: hostId, kind: 'skill' }) }
}
