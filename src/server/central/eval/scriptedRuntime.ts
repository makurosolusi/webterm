// Eval runtime (RND/29-b §4.13): replays JSONL in the shape of `opencode run --format json`
// through the real OpenCode parser/event mapping, so a recording exercises the same code
// path as a live child. Deterministic: virtual clock, no sleep, no process, no network.
import {
  type AdapterRuntimeKind, type CancelToken, type CentralRuntime, type RuntimeEmit,
  type RuntimeErrorCode, type RuntimeResult, type TurnInput, createCancelToken,
} from '../runtime/centralRuntime'
import { createOpencodeStreamParser } from '../runtime/opencodeEvents'
import {
  applyOpencodeEvent, emptyUsage, toRuntimeUsage, type SessionState,
} from '../runtime/opencodeSession'
import { createTurnEmitter } from '../runtime/runtimeEvents'

/** Injected time source; `advance` replaces real sleeping. */
export interface ScriptClock {
  now(): number
  advance(ms: number): void
}

/** Virtual clock starting at `startMs`; only `advance` moves it. */
export function createVirtualClock(startMs: number): ScriptClock {
  let current = startMs
  return { now: () => current, advance: (ms) => { current += ms } }
}

/** Virtual time one recorded line takes; drives wall-clock limits without sleeping. */
export const DEFAULT_LINE_MS = 10
const DEFAULT_SESSION_ID = 'ses_scripted'
const MICROS_PER_USD = 1_000_000

/** One logical step of a recording; `opencodeRecording` renders it as real opencode JSONL. */
export type RecordedStep =
  | { kind: 'step' }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown; output?: unknown; ok?: boolean }
  | { kind: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number; costMicros?: number }
  | { kind: 'error'; message: string }

/** Renders steps as JSONL lines (no trailing newline) in the observed `opencode run --format json` shape. */
export function opencodeRecording(steps: readonly RecordedStep[], sessionID = DEFAULT_SESSION_ID): string[] {
  return steps.map((step, index) => {
    const id = `${sessionID}_${index}`
    switch (step.kind) {
      case 'step':
        return JSON.stringify({ type: 'step_start', sessionID, part: { id } })
      case 'text':
        return JSON.stringify({ type: 'text', sessionID, part: { id, text: step.text } })
      case 'tool':
        return JSON.stringify({
          type: 'tool_use', sessionID,
          part: {
            callID: id, tool: step.name,
            state: { status: step.ok === false ? 'error' : 'completed', input: step.input, output: step.output ?? null },
          },
        })
      case 'usage':
        return JSON.stringify({
          type: 'step_finish', sessionID,
          part: {
            id, cost: (step.costMicros ?? 0) / MICROS_PER_USD,
            tokens: { input: step.input, output: step.output, reasoning: 0, cache: { read: step.cacheRead ?? 0, write: step.cacheWrite ?? 0 } },
          },
        })
      case 'error':
        return JSON.stringify({ type: 'error', sessionID, error: { name: 'UnknownError', data: { message: step.message } } })
    }
  })
}

/** One scripted turn. `hangAfterLine` stops after that many lines until cancelled (a mid-turn crash). */
export interface ScriptedTurn {
  jsonl: readonly string[]
  hangAfterLine?: number
}

export interface ScriptedRuntimeOptions {
  /** Consumed in order, one per `turn()` call. */
  turns: readonly ScriptedTurn[]
  clock: ScriptClock
  lineMs?: number
}

/** `maxTokens` is carried by the turn service's limits object but is not part of `TurnLimits`. */
function tokenCap(input: TurnInput): number | undefined {
  const raw = (input.limits as { maxTokens?: unknown }).maxTokens
  return typeof raw === 'number' ? raw : undefined
}

/** Runtime that replays recordings and enforces step/token/cost/wall limits itself. */
export class ScriptedRuntime implements CentralRuntime {
  readonly kind: AdapterRuntimeKind = 'mock'
  /** Number of `turn()` invocations; golden tests assert on it (replay must not re-run the model). */
  calls = 0
  /** Resolves once a turn reached its `hangAfterLine`. */
  readonly hung: Promise<void>
  private markHung: () => void = () => undefined
  private readonly active = new Map<string, CancelToken>()

  constructor(private readonly options: ScriptedRuntimeOptions) {
    this.hung = new Promise<void>((resolve) => { this.markHung = resolve })
  }

  async turn(input: TurnInput, emit: RuntimeEmit, signal?: AbortSignal): Promise<RuntimeResult> {
    const script = this.options.turns[this.calls]
    this.calls += 1
    if (!script) throw new Error(`scripted runtime: no scripted turn for call ${this.calls} (turn ${input.turnId})`)
    const clock = this.options.clock
    const token = createCancelToken(signal)
    this.active.set(input.turnId, token)
    const emitter = createTurnEmitter({ turnId: input.turnId, emit, now: clock.now })
    const parser = createOpencodeStreamParser()
    const totals = emptyUsage()
    const state: SessionState = { sessionRef: null, sawError: false, termination: null }
    const startedAt = clock.now()
    let steps = 0
    const finish = (outcome: RuntimeResult['outcome'], code?: RuntimeErrorCode): RuntimeResult => {
      if (code !== undefined && !state.sawError) {
        emitter.emit({ type: 'error', code, message: `scripted runtime: ${code}`, retryable: false })
      }
      const usage = toRuntimeUsage(totals, clock.now() - startedAt)
      emitter.emit({ type: 'usage', usage })
      return emitter.result(outcome, {
        usage, sessionRef: parser.sessionRef,
        ...(code === undefined ? {} : { errorCode: code }),
      })
    }
    try {
      for (const [index, line] of script.jsonl.entries()) {
        if (script.hangAfterLine === index) {
          this.markHung()
          await new Promise<void>((resolve) => token.signal.addEventListener('abort', () => resolve(), { once: true }))
        }
        if (token.cancelled) return finish('cancelled', 'cancelled')
        clock.advance(this.options.lineMs ?? DEFAULT_LINE_MS)
        const maxWall = input.limits.maxWallMs
        if (maxWall !== undefined && clock.now() - startedAt > maxWall) return finish('error', 'timeout')
        // ponytail: substring match on our own compact JSON; breaks only for hand-written recordings with spaces, parse the line if that matters.
        if (line.includes('"type":"step_start"')) {
          steps += 1
          if (input.limits.maxTurns !== undefined && steps > input.limits.maxTurns) return finish('error', 'max_turns')
        }
        for (const event of parser.push(`${line}\n`)) {
          applyOpencodeEvent(event, emitter, totals, startedAt, clock.now(), state)
        }
        const maxTokens = tokenCap(input)
        const maxCost = input.limits.maxCostMicros
        if ((maxTokens !== undefined && totals.inputTokens + totals.outputTokens > maxTokens)
          || (maxCost !== undefined && totals.costMicros > maxCost)) {
          return finish('error', 'budget_exhausted')
        }
      }
      return state.sawError ? finish('error', 'runtime_error') : finish('success')
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
  }
}
