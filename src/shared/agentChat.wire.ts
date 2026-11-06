// Server -> client event contract of the agent chat node (PLAN/AGENT-CHAT.md §4, D6/D7).
// Types only plus one limit: the server maps Claude Agent SDK messages into these events
// (server/agentChat/agentChat.events.ts) and the client renders them.

export type AgentChatStatus = 'idle' | 'starting' | 'thinking' | 'tool' | 'awaiting' | 'retry' | 'interrupted' | 'error' | 'closed'
export type AgentChatToolState = 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied'

export type AgentChatPart = { k: 'text'; text: string } | { k: 'thinking'; text: string } | { k: 'tool'; id: string } | { k: 'image'; mediaType: string }

/** One event of a session's log; `seq` is strictly increasing per session (replay with `after=<seq>`). */
export type AgentChatEvent = { seq: number } & (
  | { t: 'status'; status: AgentChatStatus; detail?: string } // retry: detail = "attempt n, retrying in Xs"
  | { t: 'init'; sessionId: string; model: string; mode: string; commands: string[]; capabilities: string[]; cliVersion: string }
  | { t: 'delta'; messageId: string; kind: 'text' | 'thinking'; text: string; parentId?: string }
  | { t: 'message'; messageId: string; role: 'user' | 'assistant'; parts: AgentChatPart[]; parentId?: string }
  | { t: 'tool'; id: string; name: string; input: unknown; state: AgentChatToolState; result?: string; truncated?: boolean; parentId?: string }
  | { t: 'permission'; requestId: string; kind: 'tool' | 'question' | 'plan'; toolName: string; toolUseId: string; input: unknown; suggestions?: unknown[]; title?: string; description?: string }
  | { t: 'permissionResolved'; requestId: string; outcome: 'allow' | 'deny' | 'cancelled' | 'expired' }
  | { t: 'result'; costUsd: number; durationMs: number; isError: boolean; interrupted: boolean; usage?: unknown; denials: number }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'mode'; mode: string })

/** An event before the session stamps its `seq`. */
export type AgentChatEventBody = AgentChatEvent extends infer E ? (E extends { seq: number } ? Omit<E, 'seq'> : never) : never

/** The client's answer to a `permission` event. */
export type AgentChatPermissionAnswer =
  | { requestId: string; behavior: 'allow'; updatedInput?: Record<string, unknown>; always?: boolean }
  | { requestId: string; behavior: 'deny'; message: string }

/** Chars of one user message (the server refuses longer; the composer says so before sending). */
export const AGENT_CHAT_TEXT_MAX = 100_000

/** Chars of a tool result sent live; longer results are cut (`truncated: true`), the full text comes from history. */
export const AGENT_CHAT_TOOL_RESULT_MAX = 16_000
