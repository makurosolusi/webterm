// The process-wide agent chat pool over the stored workspaces, built on first use (an HTTP chat
// route or a Central tool), and the ChatPort over it. Session id / config / mode changes are stored
// through CanvasPush.update, so the row is right with no UI open and an open UI follows by push.
import { getCanvasPush } from '../canvas/canvasPush.runtime'
import { findWorkspaceFor } from '../contextLinkRoute'
import { db } from '../db'
import { sessions } from '../sessions'
import { PORT } from '../launchLine'
import { activeCa2 } from '../central/ca2Active'
import { attachedSkills, type AttachedSkill } from '../skillAttach'
import { createLogger } from '../logs/logger'
import { chatCapabilityNote } from './agentChat.capabilities'
import { agentChatQueryOpener } from './agentChat.options'
import { activeAgentChatPool, AgentChatPool, agentChatOpenConfig, setAgentChatPool, type AgentChatNodePatch, type AgentChatTarget } from './agentChat.pool'
import { createAgentChatPort, type ChatPort } from './agentChat.port'

const log = createLogger('agent-chat')

function persist(workspaceId: string, nodeId: string, patch: AgentChatNodePatch): void {
  try {
    const r = getCanvasPush().update({ workspaceId, patches: [{ id: nodeId, ...patch }] })
    if (!r.ok) log.warn('agent_chat.persist_refused', 'agent chat node state was not stored', { ids: { workspaceId, nodeId }, code: r.code })
  } catch (err) {
    // The session keeps running on its in-memory state; the next change tries again.
    log.error('agent_chat.persist_failed', 'storing agent chat node state failed', { ids: { workspaceId, nodeId }, cause: err instanceof Error ? err.message : String(err) })
  }
}

/** Canvas skills cabled to the node in its stored board, resolved on the live library (none while Central skills are off). */
const attached = (t: AgentChatTarget): AttachedSkill[] => attachedSkills(t.ws, t.node.id, activeCa2()?.skills ?? null)

/** The pool of this server (created on first call). */
export function agentChatPool(): AgentChatPool {
  const had = activeAgentChatPool()
  if (had) return had
  const pool = new AgentChatPool({
    lookup: (nodeId) => {
      const ws = findWorkspaceFor(db.list(), nodeId)
      const node = ws?.nodes.find((n) => n.id === nodeId)
      return ws && node ? { ws, node } : undefined
    },
    opener: (t) => {
      return agentChatQueryOpener({ ...agentChatOpenConfig(t, { port: PORT, settings: db.getSettings() }), attachedSkills: attached(t) })
    },
    attached,
    // Ledger = the booted Central's db; without Central nothing is recorded and no note is sent.
    capabilityNote: (t) => { const h = activeCa2(); return h ? chatCapabilityNote({ db: h.db, now: h.now }, t.node.id, t.node.preset) : undefined },
    persist,
    onStatus: (nodeId, st) => sessions.setStatus(nodeId, st.status, undefined, st.reason),
  })
  setAgentChatPool(pool)
  return pool
}

let port: { pool: AgentChatPool; port: ChatPort } | undefined

/** Server-side handle on agent chat nodes (Central tools); follows the pool if it is replaced. */
export function agentChatPort(): ChatPort {
  const pool = agentChatPool()
  if (port?.pool !== pool) port = { pool, port: createAgentChatPort({ pool }) }
  return port.port
}
