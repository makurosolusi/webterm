// OpenCode CLI runtime adapter (RND/13 §3 B2). Spawns `opencode run --format json`
// without a PTY, parses its JSONL stdout, and maps it onto the central runtime
// port. No shell, no `--auto`, no logging of the prompt or child output.
import { spawn, type ChildProcess } from 'node:child_process'
import {
  type AdapterRuntimeKind, type CancelToken, type CentralRuntime, type RuntimeEmit,
  type RuntimeErrorCode, type RuntimeResult, type TurnInput,
  createCancelToken,
} from './centralRuntime'
import { createTurnEmitter, type TurnEmitter } from './runtimeEvents'
import { type OpencodeEvent, createOpencodeStreamParser } from './opencodeEvents'
import {
  type SessionState, type UsageTotals, applyOpencodeEvent, defaultOpencodeHomeDir, emptyUsage,
  prepareOpencodeHome, runtimeErrorMessage, stderrReason, toRuntimeUsage,
} from './opencodeSession'
import {
  PROVIDER_ENV_ALLOWLIST, buildOpencodeInvocation, opencodeBin, opencodeModel, opencodeToolsAllowed,
} from './opencodeOptions'
import { type OpencodeReady, sharedOpencodePreflight } from './opencodeAuth'
import { createLogger } from '../../logs/logger'

const log = createLogger('central')
/** Only the tail of stderr is kept, in memory, for the failure reason. */
const MAX_STDERR_CHARS = 8 * 1024

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
  /** Child HOME; defaults to `<dataDir>/central/home` so the user's own HOME/XDG stay unread. */
  homeDir?: string
  /** Optional `--title` for the CLI session. */
  title?: string
  /** Wall timeout when the turn does not set one. */
  maxWallMs?: number
  /** Opt-in mutating tools; defaults to denied. */
  allowTools?: boolean
  killGraceMs?: number
  now?: () => number
  /** Readiness probe (credential bridge + model check); defaults to the shared cached probe. */
  preflight?: () => Promise<OpencodeReady>
}

interface ActiveTurn {
  token: CancelToken
  child: ChildProcess | null
}

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
    const state: SessionState = {
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

      const homeDir = this.options.homeDir ?? defaultOpencodeHomeDir()
      try {
        prepareOpencodeHome(homeDir)
      } catch (err) {
        spawnError = err instanceof Error ? err : new Error('opencode home setup failed')
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error')
      }
      const model = opencodeModel(this.options.model)
      const executable = opencodeBin(this.options.executable)
      const baseEnv = this.options.env ?? process.env
      const preflight = this.options.preflight ??
        sharedOpencodePreflight({ executable, model, homeDir, env: baseEnv, cwd: this.options.cwd })
      const ready = await preflight()
      if (!ready.ok) {
        log.warn('central.opencode_unready', 'opencode runtime is not ready', { code: ready.code, reason: ready.reason })
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error', ready.reason)
      }
      if (token.cancelled) {
        return this.finish(input, emitter, totals, startedAt, state, 'cancelled', 'cancelled')
      }
      const invocation = buildOpencodeInvocation({
        homeDir,
        prompt: input.text,
        model,
        executable,
        cwd: this.options.cwd,
        env: baseEnv,
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
        for (const event of events) applyOpencodeEvent(event, emitter, totals, startedAt, this.now(), state)
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string | Buffer) => {
        apply(parser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
      })
      // Keep only a bounded tail of stderr in memory; it is redacted before it is logged or surfaced.
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string | Buffer) => {
        stderr = (stderr + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).slice(-MAX_STDERR_CHARS)
      })

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
        // `spawnError` is set in the 'error' callback, which TS narrowing cannot see; hence the cast.
        const failure = spawnError as NodeJS.ErrnoException
        const reason = `spawn failed: ${failure.code ?? failure.message}`
        return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error', reason)
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
      // Redacted one-line cause for the log and the turn error; never the prompt, never raw stderr.
      const reason = stderrReason(stderr, PROVIDER_ENV_ALLOWLIST.map((name) => baseEnv[name])) ||
        `exit ${String(child.exitCode ?? child.signalCode)}`
      log.warn('central.opencode_failed', 'opencode run failed', {
        exitCode: child.exitCode, inBandError: state.sawError, reason,
      })
      return this.finish(input, emitter, totals, startedAt, state, 'error', 'runtime_error', reason)
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

  private finish(
    input: TurnInput,
    emitter: TurnEmitter,
    totals: UsageTotals,
    startedAt: number,
    state: SessionState,
    outcome: RuntimeResult['outcome'],
    errorCode?: RuntimeErrorCode,
    reason?: string
  ): RuntimeResult {
    if (outcome === 'error' && !state.sawError && errorCode !== undefined) {
      emitter.emit({ type: 'error', code: errorCode, message: runtimeErrorMessage(errorCode, reason), retryable: false })
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
}
