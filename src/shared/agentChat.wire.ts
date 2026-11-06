// Server -> client event contract of the agent chat node (PLAN/AGENT-CHAT.md §4, D6/D7).
// Types plus the limits both sides check: the server maps Claude Agent SDK messages into these events
// (server/agentChat/agentChat.events.ts) and the client renders them.

export type AgentChatStatus = 'idle' | 'starting' | 'thinking' | 'tool' | 'awaiting' | 'retry' | 'interrupted' | 'error' | 'closed'
export type AgentChatToolState = 'running' | 'awaiting_approval' | 'done' | 'error' | 'denied'

/**
 * `image`: `data` = base64 bytes (a live user message, while the session's log budget keeps them);
 * `ref` = transcript reference served by `history?image=<ref>` (history). Neither = placeholder.
 */
export type AgentChatPart = { k: 'text'; text: string } | { k: 'thinking'; text: string } | { k: 'tool'; id: string }
  | { k: 'image'; mediaType: string; data?: string; ref?: string }

/** One event of a session's log; `seq` is strictly increasing per session (replay with `after=<seq>`). */
export type AgentChatEvent = { seq: number } & (
  | { t: 'status'; status: AgentChatStatus; detail?: string } // retry: detail = "attempt n, retrying in Xs"
  | { t: 'init'; sessionId: string; model: string; mode: string; commands: string[]; capabilities: string[]; cliVersion: string; cwd: string }
  | { t: 'delta'; messageId: string; kind: 'text' | 'thinking'; text: string; parentId?: string }
  | { t: 'message'; messageId: string; role: 'user' | 'assistant'; parts: AgentChatPart[]; parentId?: string }
  | { t: 'tool'; id: string; name: string; input: unknown; state: AgentChatToolState; result?: string; truncated?: boolean; parentId?: string }
  | { t: 'permission'; requestId: string; kind: 'tool' | 'question' | 'plan'; toolName: string; toolUseId: string; input: unknown; suggestions?: unknown[]; title?: string; description?: string }
  | { t: 'permissionResolved'; requestId: string; outcome: 'allow' | 'deny' | 'cancelled' | 'expired' }
  | { t: 'result'; costUsd: number; durationMs: number; isError: boolean; interrupted: boolean; usage?: unknown; denials: number }
  | { t: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'mode'; mode: string }
  | { t: 'config'; config: AgentChatConfig }
  | { t: 'context'; context: AgentChatContext }
  /** Output of a local slash command (or a turn's `result` text when it produced no assistant text). */
  | { t: 'commandOutput'; id: string; text: string }
  | { t: 'compact'; id: string; trigger: 'manual' | 'auto'; preTokens?: number }
  /** The conversation was reset (/clear): the node now follows `sessionId`, the timeline starts over. */
  | { t: 'reset'; sessionId: string }
  /** The slash command catalog changed: refetch `GET catalog`. */
  | { t: 'commandsChanged' }
  /** A user message waits behind the running turn (`queued: true`) or Claude picked it up (`false`). */
  | { t: 'queued'; messageId: string; queued: boolean })

/** One entry of the "/" menu (`GET catalog`). `builtin` = shipped with Claude Code, not a skill/custom/MCP prompt. */
export interface AgentChatCommand { name: string; description: string; argumentHint?: string; aliases?: string[]; builtin: boolean }
/** One model of `GET models`; `efforts` = effort levels the model supports (none = no effort control). */
export interface AgentChatModel { value: string; displayName: string; description?: string; efforts?: string[] }
/** Per-node model/effort/thinking; undefined model/effort = Claude Code's default. */
export interface AgentChatConfig { model?: string; effort?: string; thinking: boolean }
/** Context window use after the last turn, in tokens. */
export interface AgentChatContext { used: number; window: number }
/** One item of the latest TodoWrite input. */
export interface AgentChatTodo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
/** One past conversation of the node's cwd (`GET sessions`). */
export interface AgentChatSessionSummary { sessionId: string; title: string; updatedAt: number; current: boolean }

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

/** One image of a user message: base64 bytes (no data: prefix) of a type in AGENT_CHAT_IMAGE_TYPES. */
export interface AgentChatImage { mediaType: string; data: string }

/** Image types the Claude API takes as a base64 image block (Base64ImageSource.media_type). */
export const AGENT_CHAT_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** Images per message: above 20 the API applies a stricter per-image pixel limit to the whole request. */
export const AGENT_CHAT_IMAGES_MAX = 20
/** Base64 chars of one image: 5 MB, the lowest per-image limit across Claude platforms (Bedrock, Vertex). */
export const AGENT_CHAT_IMAGE_MAX_B64 = 5 * 1024 * 1024
/** Base64 chars of all images of one message. */
export const AGENT_CHAT_IMAGES_TOTAL_B64 = 20 * 1024 * 1024
/** Long edge (px) the composer downscales an image to; Claude downsizes larger images anyway. */
export const AGENT_CHAT_IMAGE_MAX_EDGE = 2000

/**
 * Built-in commands shown when the live catalog cannot load (`GET catalog` answers 409/503 with this
 * list in its body). Only commands Claude Code runs in SDK sessions (code.claude.com agent-sdk/slash-commands).
 */
export const AGENT_CHAT_FALLBACK_COMMANDS: readonly AgentChatCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free context', argumentHint: '[instructions]', builtin: true },
  { name: 'clear', description: 'Start a new conversation', builtin: true },
  { name: 'context', description: 'Show context window usage', builtin: true },
  { name: 'cost', description: 'Show token usage and cost of this session', builtin: true },
  { name: 'init', description: 'Create a CLAUDE.md for this project', builtin: true },
  { name: 'review', description: 'Review a pull request', builtin: true },
  { name: 'security-review', description: 'Security review of the pending changes', builtin: true },
]
