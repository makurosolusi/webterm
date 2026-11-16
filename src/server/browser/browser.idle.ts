// The single rule for "is this browser node idle?": whether Central may take it over for the next page, reuse it for a
// reused worker, or tidy it away. Pure: every fact comes in through `IdlePorts`; no module may keep its own copy of this rule.
import type { BrowserState } from '../../shared/browser.contract'

/** Id prefix of the browser nodes Central opens itself (`browser_read`, `browser_open`, playbooks); any other id is the user's or an agent's own. */
export const CENTRAL_BROWSER_PREFIX = 'br-'

export type IdleReason =
  | 'idle' | 'user_owned' | 'state_unknown' | 'discarded' | 'lease_agent' | 'focused' | 'loading'
  | 'cabled_active_agent' | 'cabled_unknown_node'

/** The agent behind a node id; `active` = it may still use its cabled browser (non-terminal and not `candidate_done`). */
export interface AgentOfNode { id: string; state: string; active: boolean }
export interface IdlePorts {
  stateOf(nodeId: string): BrowserState | undefined
  /** Cables (`workspace.bridges`) of the board. */
  bridgesOf(workspaceId: string): ReadonlyArray<{ source: string; target: string }>
  /** Whether the node is still on the board (a cable to a removed node is stale). */
  hasNode(workspaceId: string, nodeId: string): boolean
  agentOfNode(nodeId: string): AgentOfNode | null
  /** Node the user is looking at right now. */
  focusedNode(): string | null
}
export interface CabledTo { nodeId: string; agentId?: string; agentState?: string }
export interface IdleVerdict { idle: boolean; reason: IdleReason; owner: 'central' | 'user'; cabledTo?: CabledTo }

/** Reasons that mean someone is working with the page right now (as opposed to "not ours" or "not live"). */
const IN_USE: readonly IdleReason[] = ['lease_agent', 'focused', 'loading', 'cabled_active_agent', 'cabled_unknown_node']
/** True while an agent, the user or a cabled node is using the browser; user-owned and not-live nodes are not "in use". */
export const isInUse = (v: IdleVerdict): boolean => IN_USE.includes(v.reason)

/** Cabled peers of the node; a peer that left the board is dropped, an agent peer carries its state. */
type Cable = CabledTo & { blocks: boolean }
function cablesOf(p: IdlePorts, workspaceId: string, nodeId: string): Cable[] {
  const peers = new Set<string>()
  for (const b of p.bridgesOf(workspaceId)) {
    if (b.source === nodeId) peers.add(b.target)
    else if (b.target === nodeId) peers.add(b.source)
  }
  return [...peers].flatMap((id): Cable[] => {
    const agent = p.agentOfNode(id)
    if (agent) return [{ nodeId: id, agentId: agent.id, agentState: agent.state, blocks: agent.active }]
    // Not an agent we know: gone from the board = stale cable; still there = maybe a user's agent chat, so assume it is using the browser.
    return p.hasNode(workspaceId, id) ? [{ nodeId: id, blocks: true }] : []
  })
}

/**
 * Classifies one browser node. Only a Central-owned (`br-`) node that is live, human-leased, unfocused, not loading and
 * not cabled to a still-active agent is idle. A cable to a FINISHED agent (`candidate_done`, closed, orphaned, gone)
 * does not count: that stale cable is what used to keep every research browser "busy" forever.
 * `discarded` nodes are never auto-taken: navigate would rebuild the page, but through the raw host, bypassing the MAX_LIVE
 * slot gate (`lifecycle.attach`) and leaving the page untracked by the lifecycle (never evicted or discarded again).
 */
export function classifyBrowserNode(p: IdlePorts, workspaceId: string, nodeId: string): IdleVerdict {
  const owner = nodeId.startsWith(CENTRAL_BROWSER_PREFIX) ? 'central' : 'user'
  const cables = cablesOf(p, workspaceId, nodeId)
  const blocking = cables.find((c) => c.blocks)
  const shown = blocking ?? cables[0]
  const cabledTo: CabledTo | undefined = shown && { nodeId: shown.nodeId, ...(shown.agentId ? { agentId: shown.agentId } : {}), ...(shown.agentState ? { agentState: shown.agentState } : {}) }
  const verdict = (reason: IdleReason): IdleVerdict => ({ idle: reason === 'idle', reason, owner, ...(cabledTo ? { cabledTo } : {}) })
  const s = p.stateOf(nodeId)
  if (!s) return verdict('state_unknown')
  if (s.live === 'discarded') return verdict('discarded')
  if (s.lease === 'agent') return verdict('lease_agent')
  if (p.focusedNode() === nodeId) return verdict('focused')
  if (s.loading) return verdict('loading')
  if (blocking) return verdict(blocking.agentId ? 'cabled_active_agent' : 'cabled_unknown_node')
  return verdict(owner === 'user' ? 'user_owned' : 'idle')
}
