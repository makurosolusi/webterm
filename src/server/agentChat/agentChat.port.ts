// Server-side handle on Agent Chat nodes: lets the Central agent read and drive a chat
// node with no browser open, the way it drives a terminal Claude node. Production instance:
// agentChatPort() in agentChat.runtime.ts.
import { AGENT_CHAT_TEXT_MAX } from '../../shared/agentChat.wire'
import { isPermissionMode } from '../../shared/workspace'
import { parseConfigPatch } from './agentChat.controls'
import { historyItems, loadTranscript, type LoadTranscript } from './agentChat.history'
import type { AgentChatPool, AgentChatTarget } from './agentChat.pool'
import { chatSnapshot, chatTurns } from './agentChat.snapshot'

export type ChatStatus = 'idle' | 'starting' | 'thinking' | 'tool' | 'awaiting' | 'retry' | 'interrupted' | 'error' | 'closed'
export interface ChatSnapshot {
  live: boolean
  status: ChatStatus | null
  model: string | null
  config: { model: string | null; effort: string | null; thinking: boolean }
  permissionMode: string | null
  costUsd: number | null
  contextPct: number | null
  pending: { tool: string; summary: string } | null
}
export interface ChatTurn { role: 'user' | 'assistant'; text: string }
export type ChatFail = { ok: false; code: string; hint?: string }
export interface ChatConfigPatch { model?: string | null; effort?: string | null; thinking?: boolean }
export interface ChatPort {
  snapshot(workspaceId: string, nodeId: string): ChatSnapshot
  /** Newest last: the saved transcript (async read) plus live turns not yet in it. Not redacted. */
  tail(workspaceId: string, nodeId: string, max: number): Promise<ChatTurn[]>
  send(workspaceId: string, nodeId: string, text: string): Promise<{ ok: true; started: boolean } | ChatFail>
  configure(workspaceId: string, nodeId: string, patch: ChatConfigPatch): Promise<{ ok: true; config: ChatSnapshot['config'] } | ChatFail>
  setMode(workspaceId: string, nodeId: string, mode: string): Promise<{ ok: true; permissionMode: string } | ChatFail>
}

export interface AgentChatPortDeps {
  pool: AgentChatPool
  /** Transcript reader (tests inject one). */
  load?: LoadTranscript
}

const NOT_FOUND: ChatFail = { ok: false, code: 'node_not_found', hint: 'No agent chat node with this id in this workspace.' }
const failed = (code: string, err: unknown): ChatFail => ({ ok: false, code, hint: err instanceof Error ? err.message : String(err) })

/** The port over one pool: every call checks the node is an agent chat node of `workspaceId`. */
export function createAgentChatPort(deps: AgentChatPortDeps): ChatPort {
  const { pool } = deps
  const target = (workspaceId: string, nodeId: string): AgentChatTarget | undefined => {
    const t = pool.target(nodeId)
    return t && t.ws.id === workspaceId ? t : undefined
  }
  const blank = (): ChatSnapshot => chatSnapshot(undefined, {})

  return {
    snapshot(workspaceId, nodeId) {
      const t = target(workspaceId, nodeId)
      return t ? chatSnapshot(pool.peek(nodeId), t.node) : blank()
    },

    async tail(workspaceId, nodeId, max) {
      if (!target(workspaceId, nodeId)) return []
      const sessionId = pool.sessionId(nodeId)
      const saved = sessionId ? historyItems(await (deps.load ?? loadTranscript)(sessionId)) : []
      return chatTurns(saved, pool.peek(nodeId)?.events(0) ?? [], max)
    },

    async send(workspaceId, nodeId, text) {
      if (!target(workspaceId, nodeId)) return NOT_FOUND
      if (!text.trim() || text.length > AGENT_CHAT_TEXT_MAX) return { ok: false, code: 'invalid_text', hint: `Send between 1 and ${AGENT_CHAT_TEXT_MAX} characters.` }
      const started = !pool.peek(nodeId)?.live()
      const r = pool.send(nodeId, text)
      if (!r) return NOT_FOUND
      return r.ok ? { ok: true, started } : { ok: false, code: 'session_locked', hint: r.reason }
    },

    async configure(workspaceId, nodeId, patch) {
      if (!target(workspaceId, nodeId)) return NOT_FOUND
      const p = parseConfigPatch(patch as Record<string, unknown>)
      if ('reason' in p) return { ok: false, code: 'invalid_config', hint: p.reason }
      const s = pool.session(nodeId)
      if (!s) return NOT_FOUND
      try {
        await s.setConfig(p.patch)
      } catch (err) {
        return failed('config_failed', err)
      }
      const t = target(workspaceId, nodeId)
      return { ok: true, config: chatSnapshot(s, t?.node ?? {}).config }
    },

    async setMode(workspaceId, nodeId, mode) {
      if (!target(workspaceId, nodeId)) return NOT_FOUND
      if (!isPermissionMode(mode)) return { ok: false, code: 'invalid_mode', hint: 'mode must be one of manual, auto, acceptEdits, plan, bypassPermissions.' }
      try {
        if (!(await pool.setMode(nodeId, mode, 'central'))) return NOT_FOUND
      } catch (err) {
        return failed('mode_failed', err)
      }
      return { ok: true, permissionMode: mode }
    },
  }
}
