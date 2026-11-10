// Claude runtime adapter for Central (PLAN CENTRAL-RUNTIME-b 1.2) on the Claude Agent SDK, the engine Agent
// Chat uses. One `query()` per turn (one-shot, unlike Agent Chat's long-lived session), started through the
// Central launch profile; its messages map onto the central runtime port. No built-in tools; webterm's
// registry arrives as native MCP tools through a per-turn MCP config file (claudeMcp.ts, PLAN F2-c).
// Never logs the prompt or output; stderr only as a redacted one-line failure cause.
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { query as sdkQuery, type Query, type SDKUserMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import {
  type AdapterRuntimeKind, type CancelToken, type CentralRuntime, type RuntimeEmit,
  type RuntimeResult, createCancelToken,
} from './centralRuntime'
import { createTurnEmitter } from './runtimeEvents'
import { applyClaudeEvent, parseClaudeMessage } from './claudeEvents'
import {
  type ClaudeRuntimeOptions, type ClaudeTurnInput, DEFAULT_MAX_TURNS, DEFAULT_WALL_MS, MICROS_PER_USD, centralQueryOptions, claudeChildEnv, claudeModelArg,
} from './claudeOptions'
import { type ClaudeTurnState, defaultWorkDir, ensureWorkDir, failTurn, finishTurn, newTurnState } from './claudeSession'
import { type CentralMcpLink, type OpenedMcp, createCentralMcpLink } from './claudeMcp'
import { CENTRAL_MODEL_FLAG } from './runtimeShared'
import { FRESH_SESSION_NOTICE, isMissingSession, logTurnFailed } from './claudeFailure'
import { createLogger } from '../../logs'
import { claudeEnv } from '../../claudeProvider/claudeProvider.store'
import { centralClaudeLaunch } from '../../claudeLauncher/claudeLauncher'
import { claudeSdkSpawn } from '../../claudeLauncher/claudeSdkSpawn'
import { userContent } from '../../agentChat/agentChat.attach'

const log = createLogger('central')
/** Only the tail of stderr is kept, in memory, for the failure reason. */
const MAX_STDERR_CHARS = 8 * 1024
/** Child env names whose values are redacted out of the stderr reason. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH/i
/** How long a finished query waits for its child's stdio to close, so the stderr tail is complete. */
const CHILD_CLOSE_WAIT_MS = 1_000

type ChildExit = { code: number | null; signal: NodeJS.Signals | null }
type Launch = { argv0: string; profileId: string }

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

  async turn(input: ClaudeTurnInput, emit: RuntimeEmit, signal?: AbortSignal): Promise<RuntimeResult> {
    if (this.active.has(input.turnId)) {
      throw new Error(`claude runtime: turn ${input.turnId} is already active`)
    }
    const token = createCancelToken(signal)
    const emitter = createTurnEmitter({ turnId: input.turnId, emit, now: this.now })
    const startedAt = this.now()
    const state = newTurnState()
    let sessionId = (this.options.newSessionId ?? randomUUID)()
    // The input of the current attempt: a fresh-session retry drops `sessionRef`.
    let attempt: ClaudeTurnInput = input
    let link: OpenedMcp | null = null
    let secrets: string[] = []
    let launch: Launch | null = null
    let exit: ChildExit | undefined
    // The running query of the current attempt. Stopping it signals the child at once: the SDK's own close
    // gives it ~2 s after stdin EOF, long enough for one more MCP call past a limit (golden G7). The SDK
    // still escalates to SIGKILL if SIGTERM is ignored.
    let running: { abort: AbortController; q: Query | null; child: SpawnedProcess | null } | null = null
    const stop = (): void => {
      running?.abort.abort()
      running?.q?.close()
      const child = running?.child
      if (child && child.exitCode === null && !child.signalCode) child.kill('SIGTERM')
    }
    const finish = (): RuntimeResult => {
      const result = finishTurn(emitter, {
        state, elapsedMs: this.now() - startedAt, fallbackSessionRef: attempt.sessionRef ?? sessionId,
        ...(exit === undefined ? {} : { exit }), secrets,
      })
      if (result.outcome === 'error') logTurnFailed(input, state, result, exit, launch, secrets)
      return result
    }
    let wallTimer: ReturnType<typeof setTimeout> | undefined

    this.active.set(input.turnId, { token })
    const onAbort = (): void => {
      if (state.termination === null) state.termination = 'cancelled'
      stop()
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
          stop()
        }, wallMs)
        wallTimer.unref?.()
      }
      const runQuery = async (): Promise<void> => {
        const abort = new AbortController()
        const live = { abort, q: null as Query | null, child: null as SpawnedProcess | null }
        running = live
        let closed: Promise<void> = Promise.resolve()
        let failed: unknown = null
        const onChild = (child: SpawnedProcess): void => {
          live.child = child
          // A ChildProcess at runtime; 'close' (not 'exit') so the stderr tail is complete.
          const c = child as unknown as ChildProcess
          closed = new Promise((resolve) => {
            c.once('close', (code: number | null, sig: NodeJS.Signals | null) => { exit = { code, signal: sig }; resolve() })
            c.once('error', (err: NodeJS.ErrnoException) => { state.spawnError = err; resolve() })
          })
        }
        try {
          const built = this.queryOptions(attempt, sessionId, (link as OpenedMcp).configPath, abort, state, onChild)
          ;({ secrets, launch } = built)
          const q = (this.options.query ?? sdkQuery)({ prompt: promptOf(attempt), options: built.options })
          live.q = q
          const ctx = { emitter, state, maxTurns: attempt.limits.maxTurns ?? DEFAULT_MAX_TURNS, kill: stop, now: this.now, ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }) }
          for await (const message of q) {
            attempt.compaction?.onMessage(message)
            const event = parseClaudeMessage(message)
            if (event !== null) applyClaudeEvent(event, ctx)
          }
        } catch (err) {
          // The SDK throws when the child fails or is stopped; the exit status, spawn errno and stderr explain it.
          failed = err
        } finally {
          live.q?.close()
        }
        let waited: ReturnType<typeof setTimeout> | undefined
        await Promise.race([closed, new Promise<void>((resolve) => { waited = setTimeout(resolve, CHILD_CLOSE_WAIT_MS) })])
        clearTimeout(waited)
        // Nothing else explains a throw (no child status, no stderr): its message is the only cause left.
        if (failed !== null && exit === undefined && state.spawnError === null && state.stderrTail === '' && state.termination === null && state.failure === null) {
          state.stderrTail = failed instanceof Error ? failed.message : String(failed)
        }
      }
      await runQuery()
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
        await runQuery()
      }
      if (state.retries > 0) log.info('central.claude_retries', 'claude api retried', { retries: state.retries })
      // Without a result event (broken profile, auth, wrapper crash) the exit status and stderr are the only cause.
      return finish()
    } finally {
      if (wallTimer !== undefined) clearTimeout(wallTimer)
      token.signal.removeEventListener('abort', onAbort)
      ;(running as { q: Query | null } | null)?.q?.close()
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
  private freshText(input: ClaudeTurnInput): string {
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

  /** SDK options for one attempt, run through the Central launch profile (read per turn, so an edit reaches the next turn). */
  private queryOptions(
    input: ClaudeTurnInput, sessionId: string, mcpConfig: string, abort: AbortController, state: ClaudeTurnState,
    onChild: (child: SpawnedProcess) => void,
  ): { options: ReturnType<typeof centralQueryOptions>; secrets: string[]; launch: Launch } {
    const model = claudeModelArg(input.model ?? this.options.model ?? process.env[CENTRAL_MODEL_FLAG])
    const exe = this.options.executable
    const profile = exe ? null : centralClaudeLaunch()
    const resolved = profile ?? { argv: [exe as string], bin: exe as string }
    const launch = { argv0: basename(resolved.argv[0] as string), profileId: profile?.profile.id ?? 'executable-override' }
    // Claude provider (Settings > Capabilities) on top of the allowlist, which drops every ANTHROPIC_* var.
    // The cache env goes in first: claudeEnv applies the provider last, so it can never be clobbered.
    const env = claudeEnv({ ...claudeChildEnv(this.options.env ?? process.env), ...input.cacheEnv })
    const secrets = Object.entries(env).filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string').map(([, value]) => value as string)
    const options = {
      ...centralQueryOptions({
        mcpConfig,
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
        newSessionId: sessionId,
        ...(model.arg === undefined ? {} : { model: model.arg }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        maxTurns: input.limits.maxTurns ?? DEFAULT_MAX_TURNS,
        ...(input.limits.maxCostMicros === undefined ? {} : { maxBudgetUsd: input.limits.maxCostMicros / MICROS_PER_USD }),
        cwd: ensureWorkDir(this.options.workDir), env, abort,
        ...(input.compaction?.hooks === undefined ? {} : { hooks: input.compaction.hooks }),
      }),
      ...claudeSdkSpawn({
        launch: resolved, onChild,
        stderr: (chunk) => { state.stderrTail = (state.stderrTail + chunk).slice(-MAX_STDERR_CHARS) },
      }),
    }
    return { options, secrets, launch }
  }
}

/**
 * The prompt: one SDKUserMessage, the plain text or with images the image blocks then the text block (as
 * Agent Chat sends a paste). The SDK ends the child's stdin once it is consumed, as `-p` did.
 */
async function* promptOf(input: ClaudeTurnInput): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: userContent(input.text, input.images ?? []) }, parent_tool_use_id: null }
}
