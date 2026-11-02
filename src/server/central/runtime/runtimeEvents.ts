// Event normalization for the central runtime (RND/13 §3 B1). Adapters emit
// payloads; this module assigns per-turn sequence numbers, assembles text,
// redacts obvious secrets, and guarantees exactly one terminal `turn.result`.
import {
  type RuntimeEmit,
  type RuntimeErrorCode,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeResult,
  type RuntimeUsage,
  type TurnOutcome,
  type TurnResultEvent,
  zeroUsage,
} from './centralRuntime'
import { redactSecrets, redactValue } from '../../redactSecrets'

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.round(value)
}

/** Clamp usage numbers so a malformed adapter cannot emit negative/NaN totals. */
export function normalizeUsage(usage: Partial<RuntimeUsage> | null | undefined): RuntimeUsage {
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens),
    cacheReadTokens: count(usage?.cacheReadTokens), cacheWriteTokens: count(usage?.cacheWriteTokens),
    costMicros: count(usage?.costMicros), durationMs: count(usage?.durationMs) }
}

/** `now` is injectable for deterministic tests. */
export interface TurnEmitterOptions { turnId: string; emit: RuntimeEmit; now?: () => number }
/** `text` overrides the assembled deltas (used when partial text is saved on cancel). */
export interface TurnResultOptions {
  errorCode?: RuntimeErrorCode
  usage?: RuntimeUsage
  sessionRef?: string | null
  text?: string
}

export interface TurnEmitter {
  readonly turnId: string; readonly seq: number; readonly text: string
  readonly usage: RuntimeUsage; readonly closed: boolean; readonly finalEvent: TurnResultEvent | null
  /** False when dropped (closed or duplicate tool id). */
  emit(event: RuntimeEventInput): boolean
  textDelta(text: string): boolean
  /** Emits the one terminal event; later calls return the same result. */
  result(outcome: TurnOutcome, options?: TurnResultOptions): RuntimeResult
}

/** One emitter per turn; owns ordering, dedupe, redaction, and final-once. */
export function createTurnEmitter(options: TurnEmitterOptions): TurnEmitter {
  const at = options.now ?? Date.now
  let seq = 0
  let closed = false
  let text = ''
  let usage = zeroUsage()
  let finalEvent: TurnResultEvent | null = null
  let finalResult: RuntimeResult | null = null
  const requested = new Set<string>()
  const completed = new Set<string>()

  function normalize(body: RuntimeEventInput): RuntimeEvent {
    const base = { turnId: options.turnId, seq: ++seq, at: at() }
    switch (body.type) {
      case 'text.delta':
        return { ...base, type: 'text.delta', text: redactSecrets(body.text) }
      case 'tool.requested':
        return {
          ...base,
          type: 'tool.requested',
          toolCallId: body.toolCallId,
          name: body.name,
          input: redactValue(body.input),
        }
      case 'tool.completed':
        return {
          ...base,
          type: 'tool.completed',
          toolCallId: body.toolCallId,
          name: body.name,
          ok: body.ok,
          output: redactValue(body.output),
          ...(body.errorCode === undefined ? {} : { errorCode: body.errorCode }),
          durationMs: count(body.durationMs),
        }
      case 'error':
        return {
          ...base,
          type: 'error',
          code: body.code,
          message: redactSecrets(body.message),
          retryable: body.retryable ?? false,
        }
      case 'usage':
        return { ...base, type: 'usage', usage: normalizeUsage(body.usage) }
    }
  }

  function emit(body: RuntimeEventInput): boolean {
    if (closed) return false
    if (body.type === 'tool.requested') {
      if (requested.has(body.toolCallId)) return false
      requested.add(body.toolCallId)
    } else if (body.type === 'tool.completed') {
      if (!requested.has(body.toolCallId) || completed.has(body.toolCallId)) return false
      completed.add(body.toolCallId)
    }
    const event = normalize(body)
    if (event.type === 'text.delta') text += event.text
    else if (event.type === 'usage') usage = event.usage
    options.emit(event)
    return true
  }

  function result(outcome: TurnOutcome, opts: TurnResultOptions = {}): RuntimeResult {
    if (finalResult) return finalResult
    const resolvedUsage = normalizeUsage(opts.usage ?? usage)
    const assembled = opts.text === undefined ? text : redactSecrets(opts.text)
    const event: TurnResultEvent = {
      type: 'turn.result',
      turnId: options.turnId,
      seq: ++seq,
      at: at(),
      outcome,
      text: assembled,
      usage: resolvedUsage,
      sessionRef: opts.sessionRef ?? null,
      ...(opts.errorCode === undefined ? {} : { errorCode: opts.errorCode }),
    }
    closed = true
    finalEvent = event
    finalResult = event
    options.emit(event)
    return finalResult
  }

  return {
    turnId: options.turnId,
    get seq() { return seq },
    get text() { return text },
    get usage() { return usage },
    get closed() { return closed },
    get finalEvent() { return finalEvent },
    emit,
    textDelta: (delta: string) => emit({ type: 'text.delta', text: delta }),
    result,
  }
}

/** Reassemble assistant text from a recorded turn (replay/history read). */
export function assembleText(events: Iterable<RuntimeEvent>): string {
  let out = ''
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === 'text.delta') out += event.text
  }
  return out
}
