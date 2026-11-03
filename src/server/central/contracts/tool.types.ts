// Cross-WS contract: tool execution context, result, and coded errors (RND/29 §4.4).
// Types only. The `ToolDef`/registry shapes belong to the tool registry (WS-03), not here.
import type { ControlLevel, Tier } from './level.types'

/** A value or a promise of it; ports stay agnostic about sync vs async stores. */
export type Awaitable<T> = T | Promise<T>

/** Who asked for the effect; derived by the server, never declared by model text. */
export type ToolActorKind = 'human' | 'central' | 'worker' | 'system'

/** Server-owned context handed to every tool execution. */
export interface ToolCtx {
  conversationId: string
  turnId: string
  /** Null for the global conversation. */
  projectId: string | null
  actor: ToolActorKind
  /** Effective level read at execution time (not cached from turn start). */
  level: ControlLevel
  /** Idempotency key for effects; replaying the same value must not repeat the effect. */
  reqId?: string
  /** Aborted on cancel or kill-switch. */
  signal?: AbortSignal
  now(): number
}

/** Stable error codes; callers never parse messages. Superset of the runtime tool codes. */
export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_input'
  | 'forbidden_key'
  | 'level_denied'
  | 'tier_denied'
  | 'budget_exhausted'
  | 'breaker_open'
  | 'doom_loop'
  | 'approval_required'
  | 'not_found'
  | 'conflict'
  | 'tool_failed'

/** Coded failure of one tool call; `message` is redacted human text, not part of the contract. */
export interface ToolError {
  code: ToolErrorCode
  message: string
  tool: string
}

/** Successful execution: a bounded digest is what returns to the model, not raw data. */
export interface ToolOk {
  ok: true
  tool: string
  tier: Tier
  digest: string
  /** Audit event id when the effect was recorded. */
  auditId?: string
}

/** Failed execution wrapper around a coded error. */
export interface ToolFail {
  ok: false
  error: ToolError
}

/** Outcome of `execTool`. */
export type ToolExecResult = ToolOk | ToolFail
