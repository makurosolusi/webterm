// Deterministic S0 runtime (RND/13 §3 B1): emits text deltas, optionally calls
// the read-only `portfolio.read` tool through an injected executor, honors
// cancellation promptly, and produces usage numbers. No network, PTY, or SDK.
import {
  type AdapterRuntimeKind, type CancelToken, type CentralRuntime, type RuntimeEmit,
  type RuntimeErrorCode, type RuntimeResult, type RuntimeUsage, type TurnInput,
  createCancelToken,
} from './centralRuntime'
import { createTurnEmitter, type TurnEmitter } from './runtimeEvents'

export const MOCK_TOOL_NAME = 'portfolio.read'
/** Test-only cost basis; real adapters report SDK usage instead. */
const INPUT_COST_MICROS_PER_TOKEN = 1
const OUTPUT_COST_MICROS_PER_TOKEN = 3
const DEFAULT_STEP_DELAY_MS = 5
const CHARS_PER_TOKEN = 4

export interface MockToolRequest {
  turnId: string; conversationId: string; toolCallId: string; name: string; input: unknown
}
export interface MockToolResult { ok: boolean; output?: unknown; errorCode?: string }
export type MockToolExecutor = (request: MockToolRequest, signal: AbortSignal) =>
  MockToolResult | Promise<MockToolResult>

/** `cancel` self-cancels after the first delta; `error` fails after all deltas. */
export type MockMode = 'success' | 'error' | 'cancel'

export interface MockRuntimeOptions {
  mode?: MockMode
  /** Defaults to a stable echo of the input; tests pass explicit chunks. */
  chunks?: readonly string[]
  toolName?: string
  toolInput?: unknown
  toolExecutor?: MockToolExecutor
  stepDelayMs?: number
  now?: () => number
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function sleep(ms: number, signal: AbortSignal, capMs: number | null = null): Promise<void> {
  const wait = capMs === null ? ms : Math.min(ms, capMs)
  if (wait <= 0 || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, wait)
    signal.addEventListener('abort', done, { once: true })
  })
}

export class MockRuntime implements CentralRuntime {
  readonly kind: AdapterRuntimeKind = 'mock'
  private readonly active = new Map<string, CancelToken>()
  private readonly now: () => number

  constructor(private readonly options: MockRuntimeOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async turn(input: TurnInput, emit: RuntimeEmit, signal?: AbortSignal): Promise<RuntimeResult> {
    if (this.active.has(input.turnId)) {
      throw new Error(`mock runtime: turn ${input.turnId} is already active`)
    }
    const token = createCancelToken(signal)
    const emitter = createTurnEmitter({ turnId: input.turnId, emit, now: this.now })
    const startedAt = this.now()
    this.active.set(input.turnId, token)
    try {
      if (input.limits.maxTurns !== undefined && input.limits.maxTurns < 1) {
        return this.fail(input, emitter, startedAt, 'max_turns')
      }
      const chunks = this.options.chunks ?? [`mock[${input.turnId}] `, input.text]
      for (const chunk of chunks) {
        if (token.cancelled) return this.finish(input, emitter, startedAt, 'cancelled', 'cancelled')
        const remaining = this.remainingMs(input, startedAt)
        if (remaining !== null && remaining <= 0) return this.fail(input, emitter, startedAt, 'timeout')
        if (this.overBudget(input, emitter.text)) {
          return this.fail(input, emitter, startedAt, 'budget_exhausted')
        }
        await sleep(this.options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS, token.signal, remaining)
        if (token.cancelled) return this.finish(input, emitter, startedAt, 'cancelled', 'cancelled')
        emitter.textDelta(chunk)
        if (this.options.mode === 'cancel') {
          token.cancel('mock_cancel')
          return this.finish(input, emitter, startedAt, 'cancelled', 'cancelled')
        }
      }
      if (this.options.mode === 'error') return this.fail(input, emitter, startedAt, 'runtime_error')
      const toolError = await this.runTool(input, emitter, token)
      if (toolError === 'cancelled') return this.finish(input, emitter, startedAt, 'cancelled', 'cancelled')
      if (toolError) return this.fail(input, emitter, startedAt, toolError)
      return this.finish(input, emitter, startedAt, 'success')
    } finally {
      this.active.delete(input.turnId)
    }
  }

  cancel(turnId: string, reason?: string): boolean {
    const token = this.active.get(turnId)
    if (!token) return false
    token.cancel(reason ?? 'cancelled')
    return true
  }

  async close(): Promise<void> {
    for (const token of this.active.values()) token.cancel('closed')
    this.active.clear()
  }

  private async runTool(
    input: TurnInput, emitter: TurnEmitter, token: CancelToken
  ): Promise<RuntimeErrorCode | null> {
    const executor = this.options.toolExecutor
    const name = this.options.toolName ?? MOCK_TOOL_NAME
    if (!executor || !input.tools.includes(name)) return null
    const toolCallId = `${input.turnId}:tool:1`
    const toolInput = this.options.toolInput ?? { scope: input.conversationId }
    // `turn` owns the single error event via fail(); this method only reports the code.
    if (name !== MOCK_TOOL_NAME) return 'unknown_tool'
    emitter.emit({ type: 'tool.requested', toolCallId, name, input: toolInput })
    const toolStartedAt = this.now()
    let outcome: MockToolResult
    try {
      outcome = await executor(
        { turnId: input.turnId, conversationId: input.conversationId, toolCallId, name, input: toolInput },
        token.signal
      )
    } catch (err) {
      outcome = { ok: false, errorCode: 'tool_failed', output: { message: err instanceof Error ? err.message : 'tool error' } }
    }
    const durationMs = Math.max(0, this.now() - toolStartedAt)
    if (token.cancelled) {
      emitter.emit({ type: 'tool.completed', toolCallId, name, ok: false, errorCode: 'cancelled', durationMs })
      return 'cancelled'
    }
    emitter.emit({
      type: 'tool.completed',
      toolCallId,
      name,
      ok: outcome.ok,
      output: outcome.output,
      ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
      durationMs,
    })
    if (outcome.ok) return null
    return 'tool_failed'
  }

  private fail(input: TurnInput, emitter: TurnEmitter, startedAt: number, code: RuntimeErrorCode): RuntimeResult {
    emitter.emit({ type: 'error', code, message: `mock runtime: ${code}`, retryable: code === 'runtime_error' })
    return this.finish(input, emitter, startedAt, 'error', code)
  }

  private finish(
    input: TurnInput,
    emitter: TurnEmitter,
    startedAt: number,
    outcome: RuntimeResult['outcome'],
    errorCode?: RuntimeErrorCode
  ): RuntimeResult {
    const usage = this.estimateUsage(input, emitter.text, Math.max(0, this.now() - startedAt))
    emitter.emit({ type: 'usage', usage })
    return emitter.result(outcome, {
      usage,
      ...(errorCode === undefined ? {} : { errorCode }),
      sessionRef: input.sessionRef ?? `mock:${input.conversationId}`,
    })
  }

  private estimateUsage(input: TurnInput, text: string, durationMs: number): RuntimeUsage {
    const inputTokens = estimateTokens(input.text) + input.history.length
    const outputTokens = estimateTokens(text)
    return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
      costMicros: inputTokens * INPUT_COST_MICROS_PER_TOKEN + outputTokens * OUTPUT_COST_MICROS_PER_TOKEN,
      durationMs }
  }

  private overBudget(input: TurnInput, text: string): boolean {
    const max = input.limits.maxCostMicros
    if (max === undefined) return false
    return this.estimateUsage(input, text, 0).costMicros > max
  }

  private remainingMs(input: TurnInput, startedAt: number): number | null {
    const max = input.limits.maxWallMs
    return max === undefined || max <= 0 ? null : Math.max(0, startedAt + max - this.now())
  }
}
