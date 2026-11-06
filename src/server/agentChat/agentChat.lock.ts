// One owner per Claude session id in this server (PLAN/AGENT-CHAT.md D5): two writers on one
// transcript corrupt it. A chat node holds its session id until it closes; a terminal `agent` node of
// the same workspace showing that id blocks a resume too (it runs its own `claude --resume`).
import type { Workspace } from '../../shared/workspace'

export const AGENT_CHAT_LOCK_CHAT_NOTICE = 'This Claude session is already open in another chat node. Close it there or start a new chat here.'
export const AGENT_CHAT_LOCK_TERMINAL_NOTICE = 'This Claude session is already open in a terminal agent node of this workspace. Close that node before resuming it here.'
const TERMINAL_AGENT_KIND = 'agent'

export type AgentChatLockResult = { ok: true } | { ok: false; reason: string }

export class AgentChatLock {
  private owners = new Map<string, string>()

  /** Claim `sessionId` for `nodeId`; re-claiming one's own id is fine. `ws` = the node's workspace (terminal check). */
  acquire(sessionId: string, nodeId: string, ws?: Workspace): AgentChatLockResult {
    const owner = this.owners.get(sessionId)
    if (owner !== undefined && owner !== nodeId) return { ok: false, reason: AGENT_CHAT_LOCK_CHAT_NOTICE }
    if (ws?.nodes.some((n) => n.kind === TERMINAL_AGENT_KIND && n.sessionId === sessionId)) return { ok: false, reason: AGENT_CHAT_LOCK_TERMINAL_NOTICE }
    this.owners.set(sessionId, nodeId)
    return { ok: true }
  }

  /** Drop every id `nodeId` holds (session closed). */
  release(nodeId: string): void {
    for (const [id, owner] of this.owners) if (owner === nodeId) this.owners.delete(id)
  }

  /** Drop one id if `nodeId` holds it (the node switched conversations). */
  drop(sessionId: string, nodeId: string): void {
    if (this.owners.get(sessionId) === nodeId) this.owners.delete(sessionId)
  }

  owner(sessionId: string): string | undefined { return this.owners.get(sessionId) }
}
