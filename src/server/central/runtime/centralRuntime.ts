// Central runtime port (RND/08 §4, RND/13 §3 B1). One narrow seam every adapter
// (Claude, plus the mock for tests) implements; the turn service owns persistence.
// Pure types and cancellation primitives: no network, PTY, SDK, or database.
import type { Effort } from '../../models/modelLadder'

/** Flag-visible runtime selector. `off` means no adapter may be constructed. */
export type RuntimeKind = 'off' | 'claude' | 'mock'

/** A runtime that can actually run turns (everything except `off`). */
export type AdapterRuntimeKind = Exclude<RuntimeKind, 'off'>

export type TurnOutcome = 'success' | 'error' | 'cancelled'

/** Stable error codes so the ledger/UI never parse adapter prose. */
export type RuntimeErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'max_turns'
  | 'budget_exhausted'
  | 'tool_failed'
  | 'unknown_tool'
  | 'runtime_error'
  | 'runtime_unavailable'

export interface RuntimeUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Client-side estimate in micro-USD, never a bill. */
  costMicros: number
  durationMs: number
  /** Real model id that served the turn (from the runtime's `modelUsage`); absent when unknown. */
  model?: string
  /** Prompt-side size of the LAST model step (the window actually used); absent when unknown. */
  contextTokens?: number
  /** Ladder tier and effort the turn was asked to run on (stamped by the turn service). */
  tier?: string
  effort?: string
}

/** Usage emitted or returned before a turn has done any work. */
export function zeroUsage(): RuntimeUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, durationMs: 0 }
}

export interface TurnLimits {
  /** Hard cap on model round trips; absent means adapter default. */
  maxTurns?: number
  /** Hard cap on estimated cost in micro-USD for this turn. */
  maxCostMicros?: number
  /** Hard wall-clock cap in milliseconds for this turn. */
  maxWallMs?: number
}

/** Everything the runtime needs for one turn; all ids are server-owned. */
export interface TurnInput {
  conversationId: string
  /** Unique per turn; also the key for `CentralRuntime.cancel`. */
  turnId: string
  text: string
  /** Ids of prior messages in this conversation, oldest first (never text). */
  history: readonly string[]
  /** Tool names the adapter is allowed to call this turn (allowlist). */
  tools: readonly string[]
  limits: TurnLimits
  /** Opaque resume handle stored in the ledger; never a credential. */
  sessionRef?: string
  /** Extra child env from the context assembler (1h prompt-cache TTL); Claude only, provider env wins. */
  cacheEnv?: Readonly<Record<string, string>>
  /**
   * Prompt for a fresh session seeded with the conversation so far (the rotated-session context).
   * A runtime calls it when the resumed session is gone and it starts over; may throw.
   */
  freshSessionText?: () => string
  /** Base64 images of the human message (validated at the route); only the Claude runtime accepts them. */
  images?: readonly { mediaType: string; data: string }[]
  /** Model alias or `claude-*` id (model ladder); absent = the runtime's own setting/default. */
  model?: string
  /** Reasoning effort for this turn; absent = the CLI default for the model. */
  effort?: Effort
}

interface EventBase {
  turnId: string
  /** Monotonic per turn, starting at 1. Assigned by runtimeEvents. */
  seq: number
  at: number
}

export interface TextDeltaEvent extends EventBase {
  type: 'text.delta'
  text: string
}

export interface ToolRequestedEvent extends EventBase {
  type: 'tool.requested'
  toolCallId: string
  name: string
  input: unknown
}

export interface ToolCompletedEvent extends EventBase {
  type: 'tool.completed'
  toolCallId: string
  name: string
  ok: boolean
  output?: unknown
  errorCode?: string
  durationMs: number
}

export interface ErrorEvent extends EventBase {
  type: 'error'
  code: RuntimeErrorCode
  message: string
  retryable: boolean
}

/** Short runtime-authored note for the user (never model text, never fed back to the model). */
export interface NoticeEvent extends EventBase {
  type: 'notice'
  text: string
}

export interface UsageEvent extends EventBase {
  type: 'usage'
  usage: RuntimeUsage
}

/** The single terminal event of a turn; emitted exactly once by TurnEmitter. */
export interface TurnResultEvent extends EventBase {
  type: 'turn.result'
  outcome: TurnOutcome
  text: string
  usage: RuntimeUsage
  errorCode?: RuntimeErrorCode
  sessionRef?: string | null
}

export type RuntimeEvent =
  | TextDeltaEvent
  | ToolRequestedEvent
  | ToolCompletedEvent
  | ErrorEvent
  | UsageEvent
  | NoticeEvent
  | TurnResultEvent

/** Non-terminal payloads accepted by `TurnEmitter.emit`; `turn.result` is result-only. */
export type RuntimeEventInput =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.requested'; toolCallId: string; name: string; input: unknown }
  | {
      type: 'tool.completed'
      toolCallId: string
      name: string
      ok: boolean
      output?: unknown
      errorCode?: string
      durationMs: number
    }
  | { type: 'error'; code: RuntimeErrorCode; message: string; retryable?: boolean }
  | { type: 'usage'; usage: RuntimeUsage }
  | { type: 'notice'; text: string }

export interface RuntimeResult {
  turnId: string
  outcome: TurnOutcome
  /** Fully assembled (redacted) assistant text; partial text on cancel/error. */
  text: string
  usage: RuntimeUsage
  errorCode?: RuntimeErrorCode
  sessionRef?: string | null
}

export type RuntimeEmit = (event: RuntimeEvent) => void

/** Cancellation seam: an AbortSignal plus an idempotent `cancel()` trigger. */
export interface CancelToken {
  readonly signal: AbortSignal
  readonly cancelled: boolean
  /** Idempotent; the first reason wins at the signal level. */
  cancel(reason?: string): void
}

class LinkedCancelToken implements CancelToken {
  private readonly controller = new AbortController()
  private wasCancelled = false

  constructor(link?: AbortSignal) {
    if (!link) return
    if (link.aborted) this.cancel(link.reason)
    else link.addEventListener('abort', () => this.cancel(link.reason), { once: true })
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelled(): boolean {
    return this.wasCancelled || this.controller.signal.aborted
  }

  cancel(reason?: string): void {
    if (this.controller.signal.aborted) return
    this.wasCancelled = true
    this.controller.abort(reason)
  }
}

/** Create a cancel token, optionally linked to an upstream AbortSignal. */
export function createCancelToken(link?: AbortSignal): CancelToken {
  return new LinkedCancelToken(link)
}

/**
 * One runtime adapter. `turn` resolves once the turn reaches a terminal state and
 * must not throw for ordinary failures (use the result/error event instead).
 */
export interface CentralRuntime {
  readonly kind: AdapterRuntimeKind
  turn(input: TurnInput, emit: RuntimeEmit, signal?: AbortSignal): Promise<RuntimeResult>
  /** Cancel an in-flight turn. Idempotent; false when the id is not active. */
  cancel(turnId: string, reason?: string): boolean
  close?(): Promise<void>
}
