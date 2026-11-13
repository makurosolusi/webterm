// "Test connection": one staged check of how webterm starts Claude, used by the provider card and the
// setup wizard. Stages, in order: `wrapper` (only when the launch command has one) -> `cli` (claude
// runs, its version) -> `auth` (signed in / credential present for the mode) -> `request` (one real,
// minimal `claude -p` through the same launch path and provider env every Claude process gets).
// The first three are claudeLaunch.probe.ts; the request uses the helpers' isolation flags
// (structuredArgv: no tools, no MCP, no user settings, no session file) with --max-turns 1 and a
// 45 s cap, and is booked in the cost ledger as helper kind `connection_test`.
// The CLI's output is only matched against the failure table below, never returned: it can hold secrets.
import { tmpdir } from 'node:os'
import { bookInLedger, parseUsage, structuredArgv, SUMMARY_MODEL, type BookUsage } from '../central/context/claudeStructured'
import { mainModel } from '../central/runtime/claudeResult'
import { defaultOnPath, spawnRun, type ClaudeInstall, type LaunchFailure, type RunFn, type RunResult, type StageResult, type WrapperSignIn, probeClaudeLaunch } from '../claudeLauncher/claudeLaunch.probe'
import { createLogger } from '../logs'
import { modelRequest } from '../models/modelRequest'
import { redactSecrets } from '../redactSecrets'
import type { ResolvedClaudeLaunch } from '../../shared/claudeLaunch/claudeLaunch.profiles'
import { startupMethod } from './claudeProvider.startup'

export type ConnStage = 'wrapper' | 'cli' | 'auth' | 'request'
/** `pending`: not run on purpose (a check without the request): neither passed nor failed. */
export type ConnState = 'running' | 'ok' | 'failed' | 'skipped' | 'pending'
export type RequestFailure = 'network' | 'auth_rejected' | 'model_not_found' | 'rate_limited' | 'proxy_error' | 'timeout' | 'request_failed'
/** One progress line. `install` / `signIn`: copyable fix commands on a failed `cli` / `wrapper` stage. */
export interface StageEvent { stage: ConnStage; state: ConnState; detail?: string; hint?: string; ms?: number; install?: ClaudeInstall; signIn?: WrapperSignIn }
/** The last line. `ready`: every stage before the request passed and no request was sent (no tokens).
 *  `failed`: why (the probe's code or the request's class); `model`: the model that answered. */
export interface FinalEvent { result: 'ok' | 'ready' | 'failed'; summary: string; stage?: ConnStage; failed?: LaunchFailure | RequestFailure | 'cancelled'; ms: number; model?: string; via: string }
export type ConnEvent = StageEvent | FinalEvent

export const CONNECTION_TEST_TIMEOUT_MS = 45_000
export const CONNECTION_TEST_PROMPT = 'Reply with OK'
const STDOUT_MAX_MATCHED = 64 * 1024
const log = createLogger('claude-provider')

export const STAGE_LABEL: Record<ConnStage, string> = { wrapper: 'Wrapper', cli: 'Claude CLI', auth: 'Sign-in', request: 'Request' }

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

export const CONN_TEXT = {
  noWrapper: 'No wrapper in the launch command',
  skippedAfter: (stage: ConnStage): string => `Skipped: ${STAGE_LABEL[stage]} failed`,
  answered: (model: string, ms: number): string => `${model} answered in ${secs(ms)}`,
  works: (ms: number, via: string): string => `Connection works — Claude answered in ${secs(ms)} via ${via}`,
  failedAt: (stage: ConnStage, detail: string): string => `Failed at ${STAGE_LABEL[stage]}: ${detail}`,
  cancelled: 'Test cancelled.',
  notTested: 'Not tested yet — press Test connection to send a test request',
  ready: 'Ready to test — the last check sends one small request',
  profileMissing: 'The selected launch profile no longer exists. Pick another one.',
  request: {
    network: ['Could not reach the Claude API (DNS or network error).', 'Check the base URL and the server\'s network, proxy and firewall.'],
    auth_rejected: ['The endpoint rejected the credential (401/403).', 'Check the key or token, or sign in again with "claude auth login".'],
    model_not_found: ['The endpoint does not serve the requested model (404).', 'Set a model it serves as the default model, or set ANTHROPIC_DEFAULT_HAIKU_MODEL.'],
    rate_limited: ['Rate limited (429): the credential works but has no capacity right now.', 'Wait a minute and test again, or check the plan\'s usage limits.'],
    proxy_error: ['The proxy or gateway answered with a server error (5xx).', 'Check the gateway; the service behind it may be down.'],
    timeout: [`No answer within ${CONNECTION_TEST_TIMEOUT_MS / 1000} s.`, 'The endpoint may be slow or unreachable. Check the URL and the network.'],
    request_failed: ['Claude Code started but the request did not succeed.', 'Run the same command in a terminal on the server to see the full error.'],
  } satisfies Record<RequestFailure, [string, string]>,
}

// Matched in order against the CLI's error text (redacted first). The CLI prints the HTTP status in
// its "API Error: <status> ..." lines; network failures carry Node's error codes.
const FAILURE_TABLE: [RequestFailure, RegExp][] = [
  ['auth_rejected', /\b40[13]\b|authentication_error|permission_error|invalid (?:x-)?api[ -]key|unauthori[sz]ed|forbidden|oauth token (?:has )?expired|please run \/login/i],
  ['model_not_found', /\b404\b|not_found_error|model[^\n]{0,80}(?:not (?:found|exist|available|supported)|does not exist)|invalid model|selected model/i],
  ['rate_limited', /\b429\b|rate[_ ]limit|too many requests|usage limit/i],
  ['network', /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|connection error|unable to connect|fetch failed|socket hang up|certificate|self[- ]signed/i],
  ['proxy_error', /\b5\d\d\b|bad gateway|gateway|proxy|overloaded/i],
]

/** The CLI's failure text -> what went wrong (exported for the table test). */
export function classifyRequestFailure(text: string, timedOut: boolean): RequestFailure {
  if (timedOut) return 'timeout'
  return FAILURE_TABLE.find(([, re]) => re.test(text))?.[0] ?? 'request_failed'
}

/** The `-p` request: launch argv + the helpers' isolation flags + the cheapest tier honouring the provider's model vars. */
export function requestArgv(launch: ResolvedClaudeLaunch, env: Record<string, string | undefined>): { argv: string[]; requested: string } {
  const request = modelRequest(SUMMARY_MODEL, env)
  return { argv: [...launch.argv, ...structuredArgv(null, { model: request.flag, maxTurns: 1 }), CONNECTION_TEST_PROMPT], requested: request.requested }
}

export interface ConnDeps {
  env: NodeJS.ProcessEnv
  provider: { mode: string; ready: boolean }
  run?: RunFn
  onPath?: (name: string) => boolean
  requestTimeoutMs?: number
  book?: BookUsage
  now?: () => number
  signal?: AbortSignal
  /** false = stop before the request (opening the wizard must not spend tokens); default true. */
  sendRequest?: boolean
}

const PROBE_STAGE: Record<StageResult['stage'], ConnStage> = { wrapper: 'wrapper', claude: 'cli', auth: 'auth' }
type Parsed = { isError: boolean; text: string; raw: Parameters<typeof parseUsage>[0] & { modelUsage?: unknown } }

function parseResult(stdout: string): Parsed | null {
  try {
    const o = JSON.parse(stdout) as { is_error?: unknown; subtype?: unknown; result?: unknown; errors?: unknown }
    if (o === null || typeof o !== 'object') return null
    const text = [typeof o.result === 'string' ? o.result : '', Array.isArray(o.errors) ? o.errors.join('\n') : ''].join('\n')
    return { isError: o.is_error === true || (typeof o.subtype === 'string' && o.subtype !== 'success'), text, raw: o as Parsed['raw'] }
  } catch {
    return null // not JSON: matched as raw text only
  }
}

/** Runs the staged test, emitting every stage change and the final line; resolves with the final line. */
export async function runConnectionTest(launch: ResolvedClaudeLaunch, d: ConnDeps, emit: (e: ConnEvent) => void): Promise<FinalEvent> {
  const now = d.now ?? Date.now
  const run = d.run ?? spawnRun
  const t0 = now()
  const via = startupMethod(d.provider.mode, launch)
  const order: ConnStage[] = ['wrapper', 'cli', 'auth', 'request']
  let started = t0
  let current: ConnStage | null = null
  const begin = (stage: ConnStage): void => { current = stage; started = now(); emit({ stage, state: 'running' }) }
  const settle = (e: Omit<StageEvent, 'ms'>): void => { emit({ ...e, ms: now() - started }); current = null }
  const finish = (f: Omit<FinalEvent, 'ms' | 'via'>): FinalEvent => {
    const failedAt = f.result === 'failed' ? f.stage : undefined
    for (const s of order.slice(failedAt ? order.indexOf(failedAt) + 1 : order.length)) {
      if (s !== 'wrapper' || launch.wrapper.length > 0) emit({ stage: s, state: 'skipped', detail: CONN_TEXT.skippedAfter(failedAt as ConnStage) })
    }
    const final: FinalEvent = { ...f, ms: now() - t0, via }
    emit(final)
    return final
  }
  const cancelled = (): FinalEvent => {
    const stage = current
    if (stage) settle({ stage, state: 'failed', detail: CONN_TEXT.cancelled })
    return finish({ result: 'failed', ...(stage ? { stage } : {}), summary: CONN_TEXT.cancelled, failed: 'cancelled' })
  }

  if (launch.missingId) return finish({ result: 'failed', stage: 'wrapper', failed: 'check_failed', summary: CONN_TEXT.profileMissing })
  if (launch.wrapper.length === 0) emit({ stage: 'wrapper', state: 'skipped', detail: CONN_TEXT.noWrapper })
  begin(launch.wrapper.length > 0 ? 'wrapper' : 'cli')
  const probe = await probeClaudeLaunch(launch, {
    env: d.env, run, onPath: d.onPath ?? defaultOnPath(d.env), provider: d.provider, version: true, ...(d.signal ? { signal: d.signal } : {}),
    onStep: (s) => {
      const stage = PROBE_STAGE[s.stage]
      settle({ stage, state: s.ok ? 'ok' : 'failed', detail: s.message, ...(s.hint ? { hint: s.hint } : {}), ...(s.install ? { install: s.install } : {}), ...(s.signIn ? { signIn: s.signIn } : {}) })
      const next = order[order.indexOf(stage) + 1] as ConnStage
      if (s.ok && (next !== 'request' || d.sendRequest !== false)) begin(next)
    },
  })
  if (d.signal?.aborted) return cancelled()
  if (!probe.ok) {
    const last = probe.steps[probe.steps.length - 1] as StageResult
    const stage = PROBE_STAGE[last.stage]
    return finish({ result: 'failed', stage, ...(probe.failed ? { failed: probe.failed } : {}), summary: CONN_TEXT.failedAt(stage, last.message) })
  }

  if (d.sendRequest === false) {
    emit({ stage: 'request', state: 'pending', detail: CONN_TEXT.notTested })
    return finish({ result: 'ready', summary: CONN_TEXT.ready })
  }
  // `request` is running (begun by the auth step above).
  const { argv, requested } = requestArgv(launch, d.env)
  const timeoutMs = d.requestTimeoutMs ?? CONNECTION_TEST_TIMEOUT_MS
  let r: RunResult | null
  try { r = await run(argv[0] as string, argv.slice(1), { env: d.env, timeoutMs, cwd: tmpdir(), ...(d.signal ? { signal: d.signal } : {}) }) } catch { r = null }
  if (d.signal?.aborted) return cancelled()
  const ms = now() - started
  const parsed = r ? parseResult(r.stdout) : null
  if (parsed) {
    // Booking never fails the test: the request is already paid for.
    await Promise.resolve().then(() => (d.book ?? bookInLedger)('connection_test', parseUsage(parsed.raw, requested))).catch((err: unknown) =>
      log.warn('claude_provider.test.usage_book_failed', 'connection test usage could not be booked', { error: err instanceof Error ? err.message : String(err) }))
  }
  if (r && !r.timedOut && r.code === 0 && parsed && !parsed.isError) {
    const model = mainModel(parsed.raw.modelUsage) ?? requested
    settle({ stage: 'request', state: 'ok', detail: CONN_TEXT.answered(model, ms) })
    return finish({ result: 'ok', model, summary: CONN_TEXT.works(ms, via) })
  }
  const text = redactSecrets(`${parsed ? parsed.text : (r?.stdout ?? '')}\n${r?.stderr ?? ''}`.slice(0, STDOUT_MAX_MATCHED))
  const failed = r ? classifyRequestFailure(text, r.timedOut) : 'request_failed'
  const [detail, hint] = CONN_TEXT.request[failed]
  settle({ stage: 'request', state: 'failed', detail, hint })
  return finish({ result: 'failed', stage: 'request', failed, summary: CONN_TEXT.failedAt('request', detail) })
}
