// What an agent chat node is doing, derived from its session's event log (status, model, config,
// mode, cost, context, pending prompt) with the stored node as fallback, plus its plain-text turns.
// Read-only over the session: nothing here grows agentChat.session.ts.
import type { AgentChatConfig, AgentChatEvent, AgentChatEventBody, AgentChatPart } from '../../shared/agentChat.wire'
import type { AgentChatNodeConfig } from '../../shared/agentChat.shape'
import { isPermissionMode, type AgentPermissionMode, type WsNode } from '../../shared/workspace'
import type { ChatSnapshot, ChatTurn } from './agentChat.port'
import type { AgentChatSession } from './agentChat.session'

/** Chars of a pending prompt's summary. */
export const CHAT_PENDING_SUMMARY_MAX = 200

/** SDK permission mode -> node mode ('default' is the node's 'manual'), as the client's `nodeMode`. */
export function nodeModeOf(sdkMode: string): AgentPermissionMode | undefined {
  if (sdkMode === 'default') return 'manual'
  return isPermissionMode(sdkMode) ? sdkMode : undefined
}

/** The node's record of a server config (same shape the client stores). */
export const nodeConfigOf = (c: AgentChatConfig): AgentChatNodeConfig =>
  ({ ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), thinking: c.thinking })

export const sameNodeConfig = (a: AgentChatNodeConfig | undefined, b: AgentChatNodeConfig): boolean =>
  !!a && a.model === b.model && a.effort === b.effort && a.thinking === b.thinking

const portConfig = (c: AgentChatNodeConfig | undefined): ChatSnapshot['config'] =>
  ({ model: c?.model ?? null, effort: c?.effort ?? null, thinking: c?.thinking ?? true })

const clip = (s: string): string => (s.length > CHAT_PENDING_SUMMARY_MAX ? `${s.slice(0, CHAT_PENDING_SUMMARY_MAX - 1)}…` : s)

/** One line for a permission request: its title, else the tool input's telling field, else the input as JSON. */
export function pendingSummary(e: Extract<AgentChatEvent, { t: 'permission' }>): string {
  if (e.title) return clip(e.title)
  const input = e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : {}
  for (const k of ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'plan']) if (typeof input[k] === 'string') return clip(input[k] as string)
  return clip(JSON.stringify(e.input ?? null) ?? '')
}

/** Snapshot of a node: `session` absent = no session in the pool (live false, status null). */
export function chatSnapshot(session: AgentChatSession | undefined, node: Pick<WsNode, 'chatConfig' | 'permissionMode'>): ChatSnapshot {
  let initModel: string | undefined
  let config: AgentChatNodeConfig | undefined = node.chatConfig
  let mode: string | undefined = node.permissionMode
  let cost: number | undefined
  let queryCost = 0
  let context: number | undefined
  const pending = new Map<string, Extract<AgentChatEvent, { t: 'permission' }>>()
  for (const e of session?.events(0) ?? []) {
    if (e.t === 'init') { initModel = e.model; mode = nodeModeOf(e.mode) ?? mode }
    else if (e.t === 'mode') mode = nodeModeOf(e.mode) ?? mode
    else if (e.t === 'config') config = nodeConfigOf(e.config)
    else if (e.t === 'context') context = e.context.window > 0 ? Math.round((e.context.used / e.context.window) * 100) : undefined
    else if (e.t === 'permission') pending.set(e.requestId, e)
    else if (e.t === 'permissionResolved') pending.delete(e.requestId)
    else if (e.t === 'status' && e.status === 'starting') queryCost = 0
    else if (e.t === 'result') {
      // total_cost_usd is cumulative per Query: add the growth; a drop means a new Query started.
      // ponytail: a warm Query reopened without 'starting' whose first cost exceeds the last one is undercounted.
      cost = (cost ?? 0) + (e.costUsd >= queryCost ? e.costUsd - queryCost : e.costUsd)
      queryCost = e.costUsd
    }
  }
  const ask = [...pending.values()].at(-1)
  return {
    live: session?.live() ?? false,
    status: session?.status() ?? null,
    model: (session?.live() ? initModel : undefined) ?? config?.model ?? null,
    config: portConfig(config),
    permissionMode: mode ?? null,
    costUsd: cost ?? null,
    contextPct: context ?? null,
    pending: ask ? { tool: ask.toolName, summary: pendingSummary(ask) } : null,
  }
}

const textOf = (parts: readonly AgentChatPart[]): string => parts.flatMap((p) => (p.k === 'text' ? [p.text] : [])).join('\n')

/** Newest-last user/assistant text turns: transcript items, then live messages it lacks (by message id). */
export function chatTurns(transcript: readonly AgentChatEventBody[], live: readonly AgentChatEvent[], max: number): ChatTurn[] {
  const byId = new Map<string, ChatTurn>()
  for (const e of [...transcript, ...live]) {
    if (e.t !== 'message' || e.parentId) continue
    const text = textOf(e.parts)
    // A live message re-emitted per content block replaces its earlier copy in place (Map keeps first-seen order).
    if (text) byId.set(e.messageId, { role: e.role, text })
  }
  return max > 0 ? [...byId.values()].slice(-max) : []
}
