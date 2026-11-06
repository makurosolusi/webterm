// Claude Code CLI runtime adapter (PLAN CENTRAL-RUNTIME-b 1.2). Spawns
// `claude -p --output-format stream-json` without a shell or PTY, writes the prompt to
// stdin, and maps the JSONL stdout onto the central runtime port. No built-in tools; webterm's
// registry arrives as native MCP tools through a per-turn `--mcp-config` (claudeMcp.ts, PLAN F2-c);
// never logs the prompt or stdout; stderr only as a redacted one-line failure cause.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
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
import { stderrReason } from './opencodeSession'
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
    const sessionId = (this.options.newSessionId ?? randomUUID)()
    const finish = (exitReason?: string): RuntimeResult => finishTurn(emitter, {
      state, elapsedMs: this.now() - startedAt, fallbackSessionRef: input.sessionRef ?? sessionId,
      ...(exitReason === undefined ? {} : { exitReason }),
    })
    let child: ChildProcess | null = null
    let link: OpenedMcp | null = null
    let secrets: string[] = []
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
        failTurn(emitter, state, { code: 'runtime_error' })
        return finish()
      }
      if (token.cancelled) return this.cancelled(state, finish)
      try {
        ;({ child, secrets } = this.spawnChild(input, sessionId, link.configPath))
      } catch (err) {
        state.spawnError = err instanceof Error ? err : new Error('claude spawn failed')
        return finish()
      }
      const live = child
      ladder = createKillLadder(live, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
      const kill = (): void => ladder?.start()
      let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null }
      const closed = new Promise<void>((resolve) => {
        live.once('close', (code: number | null, signal: NodeJS.Signals | null) => { exit = { code, signal }; resolve() })
        live.once('error', (err) => {
          state.spawnError = err
          resolve()
        })
      })
      this.pump(live, input, emitter, state, kill)

      const wallMs = input.limits.maxWallMs ?? DEFAULT_WALL_MS
      if (wallMs > 0) {
        wallTimer = setTimeout(() => {
          if (state.termination === null) state.termination = 'timeout'
          kill()
        }, wallMs)
        wallTimer.unref?.()
      }
      await closed
      if (state.retries > 0) log.info('central.claude_retries', 'claude api retried', { retries: state.retries })
      if (state.result !== null || state.failure !== null || state.termination !== null || state.spawnError !== null) return finish()
      // Ended without a result event (broken profile, auth, wrapper crash): the exit status and stderr are the only cause.
      const status = exit.code !== null ? `exit ${exit.code}` : `signal ${exit.signal ?? 'unknown'}`
      const reason = stderrReason(state.stderrTail, secrets) || status
      log.error('central.claude_exit_failed', 'claude exited without a result', { turnId: input.turnId, exitCode: exit.code, signal: exit.signal, reason })
      return finish(reason === status ? status : `${status}: ${reason}`)
    } finally {
      if (wallTimer !== undefined) clearTimeout(wallTimer)
      ladder?.clear()
      token.signal.removeEventListener('abort', onAbort)
      if (child !== null && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
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

  private spawnChild(input: TurnInput, sessionId: string, mcpConfig: string): { child: ChildProcess; secrets: string[] } {
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
    const [cmd, ...args] = this.options.executable ? [this.options.executable, ...argv] : [...centralClaudeLaunch().argv, ...argv]
    // Claude provider (Settings > Capabilities) on top of the allowlist, which drops every ANTHROPIC_* var.
    // The cache env goes in first: claudeEnv applies the provider last, so it can never be clobbered.
    const env = claudeEnv({ ...claudeChildEnv(this.options.env ?? process.env), ...input.cacheEnv })
    const secrets = Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string').map(([, value]) => value as string)
    const child = spawn(cmd as string, args, { cwd: ensureWorkDir(this.options.workDir), env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    return { child, secrets }
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
