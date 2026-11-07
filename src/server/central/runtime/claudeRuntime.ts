// Claude Code CLI runtime adapter (PLAN CENTRAL-RUNTIME-b 1.2). Spawns
// `claude -p --output-format stream-json` without a shell or PTY, writes the prompt to
// stdin, and maps the JSONL stdout onto the central runtime port. No built-in tools; webterm's
// registry arrives as native MCP tools through a per-turn `--mcp-config` (claudeMcp.ts, PLAN F2-c);
// never logs the prompt or stdout; stderr only as a redacted one-line failure cause.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import {
  type AdapterRuntimeKind, type CancelToken, type CentralRuntime, type RuntimeEmit,
  type RuntimeResult, type TurnInput, createCancelToken,
} from './centralRuntime'
import { createTurnEmitter, type TurnEmitter } from './runtimeEvents'
import { applyClaudeEvent, parseClaudeLine } from './claudeEvents'
import {
  type ClaudeRuntimeOptions, DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_TURNS,
  DEFAULT_WALL_MS, MICROS_PER_USD, claudeArgv, claudeChildEnv, claudeModelArg, createLineReader,
} from './claudeOptions'
import {
  type ClaudeTurnState, createKillLadder, defaultWorkDir, ensureWorkDir, failTurn, finishTurn, newTurnState,
} from './claudeSession'
import { type CentralMcpLink, type OpenedMcp, createCentralMcpLink } from './claudeMcp'
import { CENTRAL_MODEL_FLAG } from './opencodeOptions'
import { FRESH_SESSION_NOTICE, isMissingSession, logTurnFailed } from './claudeFailure'
import { createLogger } from '../../logs'
import { claudeEnv } from '../../claudeProvider/claudeProvider.store'
import { centralClaudeLaunch } from '../../claudeLauncher/claudeLauncher'

const log = createLogger('central')
/** Only the tail of stderr is kept, in memory, for the failure reason. */
const MAX_STDERR_CHARS = 8 * 1024
/** Child env names whose values are redacted out of the stderr reason. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i

interface ActiveTurn {
  token: CancelToken
}

export class ClaudeRuntime implements CentralRuntime {
  readonly kind: AdapterRuntimeKind = 'claude'
  private readonly active = new Map<string, ActiveTurn>()
  private readonly now: () => number
  private readonly mcp: CentralMcpLink

  constructor(private readonly options: ClaudeRuntimeOptions = {}) {
    this.now = options.now ?? Date.now
    // Turn files sit next to the empty work dir (same 0700 data tree), never inside it.
    this.mcp = options.mcp ?? createCentralMcpLink({ dir: join(dirname(options.workDir ?? defaultWorkDir()), 'mcp') })
  }

  async turn(input: TurnInput, emit: RuntimeEmit, signal?: AbortSignal): Promise<RuntimeResult> {
    if (this.active.has(input.turnId)) {
      throw new Error(`claude runtime: turn ${input.turnId} is already active`)
    }
    const token = createCancelToken(signal)
    const emitter = createTurnEmitter({ turnId: input.turnId, emit, now: this.now })
    const startedAt = this.now()
    const state = newTurnState()
    let sessionId = (this.options.newSessionId ?? randomUUID)()
    // The input of the current attempt: a fresh-session retry drops `sessionRef`.
    let attempt: TurnInput = input
    let child: ChildProcess | null = null
    let link: OpenedMcp | null = null
    let secrets: string[] = []
    let launch: { argv0: string; profileId: string } | null = null
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    const finish = (): RuntimeResult => {
      const result = finishTurn(emitter, {
        state, elapsedMs: this.now() - startedAt, fallbackSessionRef: attempt.sessionRef ?? sessionId,
        ...(exit === undefined ? {} : { exit }), secrets,
      })
      if (result.outcome === 'error') logTurnFailed(input, state, result, exit, launch, secrets)
      return result
    }
    let ladder: ReturnType<typeof createKillLadder> | null = null
    let wallTimer: ReturnType<typeof setTimeout> | undefined

    this.active.set(input.turnId, { token })
    const onAbort = (): void => {
      if (state.termination === null) state.termination = 'cancelled'
      ladder?.start()
    }
    token.signal.addEventListener('abort', onAbort, { once: true })

    try {
      if (input.limits.maxTurns !== undefined && input.limits.maxTurns < 1) {
        failTurn(emitter, state, { code: 'max_turns' })
        return finish()
      }
      if (token.cancelled) return this.cancelled(state, finish)
      const ready = await this.ready()
      if (token.cancelled) return this.cancelled(state, finish)
      if (!ready.ok) {
        failTurn(emitter, state, { code: 'runtime_unavailable', unavailable: ready.code })
        return finish()
      }

      try {
        link = await this.mcp.open({ conversationId: input.conversationId, turnId: input.turnId, wallMs: input.limits.maxWallMs ?? DEFAULT_WALL_MS })
      } catch (err) {
        log.error('central.claude_mcp_failed', 'central MCP wiring failed; turn not started', { turnId: input.turnId, error: err instanceof Error ? err.message : String(err) })
        failTurn(emitter, state, { code: 'runtime_error', reason: 'webterm could not prepare its tool server for Claude' })
        return finish()
      }
      if (token.cancelled) return this.cancelled(state, finish)
      const wallMs = input.limits.maxWallMs ?? DEFAULT_WALL_MS
      if (wallMs > 0) {
        wallTimer = setTimeout(() => {
          if (state.termination === null) state.termination = 'timeout'
          ladder?.start()
        }, wallMs)
        wallTimer.unref?.()
      }
      const runChild = async (): Promise<void> => {
        try {
          ;({ child, secrets, launch } = this.spawnChild(attempt, sessionId, (link as OpenedMcp).configPath))
        } catch (err) {
          state.spawnError = err instanceof Error ? err : new Error('claude spawn failed')
          return
        }
        const live = child
        ladder?.clear()
        ladder = createKillLadder(live, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
        const closed = new Promise<void>((resolve) => {
          live.once('close', (code: number | null, signal: NodeJS.Signals | null) => { exit = { code, signal }; resolve() })
          live.once('error', (err) => {
            state.spawnError = err
            resolve()
          })
        })
        this.pump(live, attempt, emitter, state, () => ladder?.start())
        await closed
      }
      await runChild()
      // A resumed session Claude no longer has (deleted, other machine, other runtime's id) would fail
      // every turn: retry once in a fresh session, but only while nothing has reached the user yet.
      if (attempt.sessionRef !== undefined && state.failure === null && state.termination === null
        && !state.sawDelta && state.seenTools.size === 0 && isMissingSession(state.result?.errorText, state.stderrTail)) {
        log.info('central.session.reset', 'resumed claude session missing; retrying in a fresh session', {
          conversationId: input.conversationId, turnId: input.turnId, oldSessionPrefix: attempt.sessionRef.slice(0, 8),
        })
        attempt = { ...attempt, text: this.freshText(input) }
        delete attempt.sessionRef
        sessionId = (this.options.newSessionId ?? randomUUID)()
        Object.assign(state, newTurnState())
        exit = undefined
        emitter.emit({ type: 'notice', text: FRESH_SESSION_NOTICE })
        if (token.cancelled) return this.cancelled(state, finish)
        await runChild()
      }
      if (state.retries > 0) log.info('central.claude_retries', 'claude api retried', { retries: state.retries })
      // Without a result event (broken profile, auth, wrapper crash) the exit status and stderr are the only cause.
      return finish()
    } finally {
      if (wallTimer !== undefined) clearTimeout(wallTimer)
      // Both are assigned inside runChild, which TS flow analysis does not see.
      ;(ladder as ReturnType<typeof createKillLadder> | null)?.clear()
      token.signal.removeEventListener('abort', onAbort)
      const last = child as ChildProcess | null
      if (last !== null && last.exitCode === null && last.signalCode === null) last.kill('SIGKILL')
      link?.close()
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

  private cancelled(state: ClaudeTurnState, finish: () => RuntimeResult): RuntimeResult {
    state.termination = 'cancelled'
    return finish()
  }

  /** The rotated-session prompt for a fresh session; the turn's own prompt if it cannot be built. */
  private freshText(input: TurnInput): string {
    if (input.freshSessionText === undefined) return input.text
    try {
      return input.freshSessionText()
    } catch (err) {
      // The retry still runs, only without the earlier conversation; the notice already says the session is new.
      log.warn('central.session.reseed_failed', 'fresh-session context could not be built', {
        turnId: input.turnId, error: err instanceof Error ? err.name : typeof err,
      })
      return input.text
    }
  }

  /** Runs the injected preflight; a throwing check counts as "could not check", never as ready. */
  private async ready(): Promise<Awaited<ReturnType<NonNullable<ClaudeRuntimeOptions['preflight']>>>> {
    const check = this.options.preflight
    if (check === undefined) return { ok: true }
    try {
      return await check()
    } catch (err) {
      log.warn('central.claude_preflight_threw', 'claude preflight threw', { reason: err instanceof Error ? err.name : typeof err })
      return { ok: false, code: 'claude_check_failed', hint: '' }
    }
  }

  private spawnChild(input: TurnInput, sessionId: string, mcpConfig: string): {
    child: ChildProcess; secrets: string[]; launch: { argv0: string; profileId: string }
  } {
    const model = claudeModelArg(this.options.model ?? process.env[CENTRAL_MODEL_FLAG])
    const argv = claudeArgv({
      mcpConfig,
      ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
      newSessionId: sessionId,
      ...(model.arg === undefined ? {} : { model: model.arg }),
      maxTurns: input.limits.maxTurns ?? DEFAULT_MAX_TURNS,
      ...(input.limits.maxCostMicros === undefined ? {} : { maxBudgetUsd: input.limits.maxCostMicros / MICROS_PER_USD }),
    })
    // Central launch profile (e.g. `envman -e p -- claude`) read per turn, so a profile edit reaches the next turn.
    const profile = this.options.executable ? null : centralClaudeLaunch()
    const [cmd, ...args] = profile ? [...profile.argv, ...argv] : [this.options.executable as string, ...argv]
    const launch = { argv0: basename(cmd as string), profileId: profile?.profile.id ?? 'executable-override' }
    // Claude provider (Settings > Capabilities) on top of the allowlist, which drops every ANTHROPIC_* var.
    // The cache env goes in first: claudeEnv applies the provider last, so it can never be clobbered.
    const env = claudeEnv({ ...claudeChildEnv(this.options.env ?? process.env), ...input.cacheEnv })
    const secrets = Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string').map(([, value]) => value as string)
    const child = spawn(cmd as string, args, { cwd: ensureWorkDir(this.options.workDir), env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    return { child, secrets, launch }
  }

  /** Wires stdin (prompt then EOF), stdout (JSONL to events) and keeps a bounded stderr tail for the failure cause. */
  private pump(child: ChildProcess, input: TurnInput, emitter: TurnEmitter, state: ClaudeTurnState, kill: () => void): void {
    const reader = createLineReader()
    const maxTurns = input.limits.maxTurns ?? DEFAULT_MAX_TURNS
    const ctx = { emitter, state, maxTurns, kill, now: this.now, ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }) }
    const apply = (lines: string[]): void => {
      for (const line of lines) {
        const event = parseClaudeLine(line)
        if (event !== null) applyClaudeEvent(event, ctx)
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => apply(reader.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))))
    child.stdout?.on('end', () => apply(reader.end()))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string | Buffer) => {
      state.stderrTail = (state.stderrTail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))).slice(-MAX_STDERR_CHARS)
    })
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE when the child exits before reading the prompt; its exit path reports the failure.
      log.warn('central.claude_stdin_failed', 'claude stdin write failed', { code: err.code ?? 'unknown' })
    })
    child.stdin?.end(input.text)
  }
}
