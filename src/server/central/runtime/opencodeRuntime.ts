// OpenCode CLI runtime adapter (RND/13 §3 B2). Spawns `opencode run --format json`
// without a PTY, parses its JSONL stdout, and maps it onto the central runtime
// port. No shell, no `--auto`, no logging of the prompt or child output.
import { spawn, type ChildProcess } from 'node:child_process'
import {
  type AdapterRuntimeKind, type CancelToken, type CentralRuntime, type RuntimeEmit,
  type RuntimeErrorCode, type RuntimeResult, type RuntimeUsage, type TurnInput,
  createCancelToken,
} from './centralRuntime'
import { createTurnEmitter, type TurnEmitter } from './runtimeEvents'
import { type OpencodeEvent, type OpencodeUsageDelta, createOpencodeStreamParser } from './opencodeEvents'
import {
  buildOpencodeInvocation, opencodeBin, opencodeModel, opencodeToolsAllowed,
} from './opencodeOptions'

/** Session resume only works when the CLI returns a session id; otherwise null. */
const DEFAULT_WALL_MS = 10 * 60_000
const DEFAULT_KILL_GRACE_MS = 500

export interface OpenCodeRuntimeOptions {
  /** Child working directory; defaults to the server cwd. */
  cwd?: string
  /** Executable override; defaults to `WEBTERM_OPENCODE_BIN` or `opencode`. */
  executable?: string
  /** Model override; defaults to `WEBTERM_CENTRAL_MODEL`. */
  model?: string
  /** Base environment; scrubbed before spawn. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Optional `--title` for the CLI session. */
  title?: string
  /** Wall timeout when the turn does not set one. */
  maxWallMs?: number
  /** Opt-in mutating tools; defaults to denied. */
  allowTools?: boolean
  killGraceMs?: number
  now?: () => number
}

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costMicros: number
}

interface ActiveTurn {
  token: CancelToken
  child: ChildProcess | null
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 }
}

function addUsage(totals: UsageTotals, delta: OpencodeUsageDelta): void {
  totals.inputTokens += delta.inputTokens
  // Reasoning tokens are generated tokens; RuntimeUsage has no separate bucket.
  totals.outputTokens += delta.outputTokens + delta.reasoningTokens
  totals.cacheReadTokens += delta.cacheReadTokens
  totals.cacheWriteTokens += delta.cacheWriteTokens
  totals.costMicros += delta.costMicros
}

function toRuntimeUsage(totals: UsageTotals, durationMs: number): RuntimeUsage {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costMicros: totals.costMicros,
    durationMs: Math.max(0, Math.round(durationMs)),
  }
}

type Termination = 'cancelled' | 'timeout' | null

export class OpenCodeRuntime implements CentralRuntime {
  readonly kind: AdapterRuntimeKind = 'opencode'
  private readonly active = new Map<string, ActiveTurn>()
  private readonly now: () => number

  constructor(private readonly options: OpenCodeRuntimeOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async turn(input: TurnInput, emit: RuntimeEmit, signal?: AbortSignal): Promise<RuntimeResult> {
    if (this.active.has(input.turnId)) {
      throw new Error(`opencode runtime: turn ${input.turnId} is already active`)
    }
    const token = createCancelToken(signal)
    const emitter = createTurnEmitter({ turnId: input.turnId, emit, now: this.now })
    const startedAt = this.now()
    const totals = emptyUsage()
    const state: { sessionRef: string | null; sawError: boolean; termination: Termination } = {
      sessionRef: null,
      sawError: false,
      termination: null,
    }
    let child: ChildProcess | null = null
    let spawnError: Error | null = null
    let wallTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const entry: ActiveTurn = { token, child: null }
    this.active.set(input.turnId, entry)

    const stopChild = (): void => {
      const current = entry.child
      if (current === null || current.exitCode !== null || current.signalCode !== null) return
      current.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (current.exitCode === null && current.signalCode === null) current.kill('SIGKILL')
      }, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const onAbort = (): void => {
      if (state.termination === null) state.termination = 'cancelled'
      stopChild()
    }
    token.signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (input.limits.maxTurns !== undefined && input.limits.maxTurns < 1) {
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'max_turns')
      }
      if (token.cancelled) {
        return this.finish(input, emitter, totals, startedAt, state, 'cancelled', 'cancelled')
      }

      const invocation = buildOpencodeInvocation({
        prompt: input.text,
        model: opencodeModel(this.options.model),
        executable: opencodeBin(this.options.executable),
        cwd: this.options.cwd,
        env: this.options.env,
        title: this.options.title,
        sessionRef: input.sessionRef ?? null,
        allowTools: this.options.allowTools ?? opencodeToolsAllowed(),
      })

      try {
        child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          env: invocation.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        })
      } catch (err) {
        spawnError = err instanceof Error ? err : new Error('spawn failed')
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error')
      }
      entry.child = child

      const parser = createOpencodeStreamParser()
      const apply = (events: OpencodeEvent[]): void => {
        for (const event of events) this.applyEvent(event, emitter, totals, startedAt, state)
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string | Buffer) => {
        apply(parser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
      })
      // Drain stderr so the child cannot block; the text is never retained.
      child.stderr?.resume()

      const wallMs = input.limits.maxWallMs ?? this.options.maxWallMs ?? DEFAULT_WALL_MS
      if (wallMs > 0) {
        wallTimer = setTimeout(() => {
          if (state.termination === null) state.termination = 'timeout'
          stopChild()
        }, wallMs)
        wallTimer.unref?.()
      }

      await new Promise<void>((resolve) => {
        const settle = (): void => resolve()
        child?.once('close', settle)
        child?.once('error', (err) => {
          spawnError = err instanceof Error ? err : new Error('spawn failed')
          settle()
        })
      })
      apply(parser.end())
      state.sessionRef = parser.sessionRef
      if (spawnError !== null) {
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error')
      }
      if (state.termination === 'cancelled') {
        return this.finish(input, emitter, totals, startedAt, state, 'cancelled', 'cancelled')
      }
      if (state.termination === 'timeout') {
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'timeout')
      }
      if (child.exitCode === 0 && !state.sawError) {
        return this.finish(input, emitter, totals, startedAt, state, 'success')
      }
      // A non-zero exit (or an in-band error with exit 0) is a runtime failure.
      return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error')
    } finally {
      if (wallTimer !== undefined) clearTimeout(wallTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      token.signal.removeEventListener('abort', onAbort)
      if (child !== null) stopChild()
      this.active.delete(input.turnId)
    }
  }

  cancel(turnId: string, reason?: string): boolean {
    const entry = this.active.get(turnId)
    if (!entry) return false
    entry.token.cancel(reason ?? 'cancelled')
    return true
  }

  async close(): Promise<void> {
    for (const entry of this.active.values()) entry.token.cancel('closed')
    this.active.clear()
  }

  private applyEvent(
    event: OpencodeEvent,
    emitter: TurnEmitter,
    totals: UsageTotals,
    startedAt: number,
    state: { sessionRef: string | null; sawError: boolean; termination: Termination }
  ): void {
    switch (event.type) {
      case 'text':
        emitter.textDelta(event.text)
        return
      case 'tool.requested':
        emitter.emit({
          type: 'tool.requested',
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
        })
        return
      case 'tool.completed':
        emitter.emit({
          type: 'tool.completed',
          toolCallId: event.toolCallId,
          name: event.name,
          ok: event.ok,
          ...(event.output === undefined ? {} : { output: event.output }),
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          durationMs: 0,
        })
        return
      case 'usage': {
        addUsage(totals, event.usage)
        emitter.emit({ type: 'usage', usage: toRuntimeUsage(totals, this.now() - startedAt) })
        return
      }
      case 'error':
        // One adapter error event per turn; a later non-zero exit adds no duplicate.
        if (!state.sawError) {
          state.sawError = true
          emitter.emit({ type: 'error', code: event.code, message: event.message, retryable: false })
        }
        return
      default:
        return
    }
  }

  private finish(
    input: TurnInput,
    emitter: TurnEmitter,
    totals: UsageTotals,
    startedAt: number,
    state: { sessionRef: string | null; sawError: boolean; termination: Termination },
    outcome: RuntimeResult['outcome'],
    errorCode?: RuntimeErrorCode
  ): RuntimeResult {
    if (outcome === 'error' && !state.sawError && errorCode !== undefined) {
      emitter.emit({ type: 'error', code: errorCode, message: this.errorMessage(errorCode), retryable: false })
    }
    if (state.sessionRef === null && input.sessionRef !== undefined) {
      state.sessionRef = input.sessionRef
    }
    const usage = toRuntimeUsage(totals, this.now() - startedAt)
    emitter.emit({ type: 'usage', usage })
    return emitter.result(outcome, {
      usage,
      ...(errorCode === undefined ? {} : { errorCode }),
      sessionRef: state.sessionRef,
    })
  }

  /** Stable, input-free messages: never echo child output or the prompt. */
  private errorMessage(code: RuntimeErrorCode): string {
    switch (code) {
      case 'timeout':
        return 'opencode timed out'
      case 'cancelled':
        return 'opencode turn cancelled'
      case 'max_turns':
        return 'opencode turn limit reached'
      default:
        return 'opencode runtime failed'
    }
  }
}
