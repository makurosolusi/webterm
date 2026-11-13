// The one `claude -p` runner for Central's helpers (policy classifier, checkpoint summarizer, handoff card
// narrative, morning brief narrative, memory consolidator): a small model with a strict JSON schema
// (structured outputs: `structured_output`, subtype `success`), no tools, no MCP, no user settings/hooks,
// no session file, per-call budget, hourly cap; the caller's abort kills the child. Every answer carries the
// CLI's usage (tokens, `total_cost_usd`, the real model from `modelUsage`), and `createClaudeStructured`
// books it in the cost ledger under the helper's kind, so helper spend is visible next to Central's own.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import { claudeChildEnv } from '../runtime/claudeOptions'
import { mainModel } from '../runtime/claudeResult'
import { claudeEnv } from '../../claudeProvider/claudeProvider.store'
import { centralClaudeLaunch } from '../../claudeLauncher/claudeLauncher'
import { createLogger } from '../../logs'
import { modelRequest } from '../../models/modelRequest'
import type { HelperKind, HelperUsage } from '../../cost/costCapture'

export const SUMMARY_MODEL = 'haiku'
/** Helpers do short, schema-bound work: low effort unless a caller asks for more. */
export const HELPER_EFFORT: EffortLevel = 'low'
export const SUMMARY_BUDGET_USD = 0.05
export const SUMMARY_MAX_PER_HOUR = 60
const MAX_TURNS = 3
const STDOUT_MAX = 512 * 1024
const HOUR_MS = 3_600_000
const USD_TO_MICROS = 1e6

const log = createLogger('central')

/** The model port: prompt + schema in, the validated-by-the-CLI JSON value out. Tests inject a fake. */
export type StructuredCall = (req: { prompt: string; schema: object }, signal: AbortSignal) => Promise<unknown>
/** Structured output plus the usage it cost. */
export interface StructuredAnswer { output: unknown; usage: HelperUsage }
/** The raw runner: like StructuredCall, but returns usage too (the consolidator books it itself). */
export type StructuredRun = (req: { prompt: string; schema: object }, signal: AbortSignal) => Promise<StructuredAnswer>

/** Where a helper answer's usage goes; the default books it in the active ledger. */
export type BookUsage = (kind: HelperKind, usage: HelperUsage) => void | Promise<void>

export interface StructuredOptions {
  /** Overridable so tests never reach a real model. */
  bin?: string
  now?: () => number
  model?: string
  effort?: EffortLevel
  maxPerHour?: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** Usage of one parsed `claude -p --output-format json` result: tokens, the CLI's cost, the model that ran. */
export function parseUsage(o: { total_cost_usd?: unknown; usage?: Record<string, unknown>; modelUsage?: unknown }, requestedModel: string): HelperUsage {
  const u = o.usage ?? {}
  const cost = typeof o.total_cost_usd === 'number' && Number.isFinite(o.total_cost_usd) ? Math.round(o.total_cost_usd * USD_TO_MICROS) : null
  return {
    input: num(u['input_tokens']), output: num(u['output_tokens']), cacheRead: num(u['cache_read_input_tokens']),
    cacheWrite: num(u['cache_creation_input_tokens']), costMicros: cost, model: mainModel(o.modelUsage) ?? requestedModel,
  }
}

/** `claude -p --output-format json` stdout -> structured output + usage; throws on anything but success. */
export function parseStructuredAnswer(stdout: string, requestedModel: string = SUMMARY_MODEL): StructuredAnswer {
  const o = JSON.parse(stdout) as {
    subtype?: string; is_error?: boolean; structured_output?: unknown; total_cost_usd?: unknown
    usage?: Record<string, unknown>; modelUsage?: unknown
  }
  if (o.subtype !== 'success' || o.is_error || o.structured_output === undefined || o.structured_output === null) {
    throw new Error(`no structured output (${o.subtype ?? 'unknown'})`)
  }
  return { output: o.structured_output, usage: parseUsage(o, requestedModel) }
}

/** `model: null` passes no `--model` (the provider's own model applies); `schema: null` = plain text answer. */
export function structuredArgv(schema: object | null, opts: { model?: string | null; effort?: EffortLevel; maxTurns?: number } = {}): string[] {
  const model = opts.model === undefined ? SUMMARY_MODEL : opts.model
  return ['-p', '--output-format', 'json', ...(schema === null ? [] : ['--json-schema', JSON.stringify(schema)]), ...(model === null ? [] : ['--model', model]),
    '--effort', opts.effort ?? HELPER_EFFORT,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
    '--max-turns', String(opts.maxTurns ?? MAX_TURNS), '--max-budget-usd', String(SUMMARY_BUDGET_USD)]
}

/** The `claude -p` runner for helper `kind`; the hourly cap is per runner. */
export function createStructuredRunner(kind: HelperKind, opts: StructuredOptions = {}): StructuredRun {
  const now = opts.now ?? Date.now
  const maxPerHour = opts.maxPerHour ?? SUMMARY_MAX_PER_HOUR
  const model = opts.model ?? SUMMARY_MODEL
  const calls: number[] = []
  return (req, signal) => new Promise<StructuredAnswer>((resolve, reject) => {
    const at = now()
    while (calls.length && at - calls[0]! >= HOUR_MS) calls.shift()
    if (calls.length >= maxPerHour) { reject(new Error(`${kind}: hourly cap reached`)); return }
    if (signal.aborted) { reject(new Error(`${kind}: aborted before start`)); return }
    calls.push(at)
    const env = claudeEnv(claudeChildEnv(process.env))
    const request = modelRequest(model, env)
    const argv = structuredArgv(req.schema, { model: request.flag, ...(opts.effort ? { effort: opts.effort } : {}) })
    const [cmd, ...args] = opts.bin ? [opts.bin, ...argv] : [...centralClaudeLaunch().argv, ...argv]
    const child = spawn(cmd as string, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    let out = ''
    const kill = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (out.length < STDOUT_MAX) out += chunk })
    child.on('error', (err) => reject(new Error(`${kind}: claude spawn failed: ${err.message}`)))
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill)
      if (code !== 0) { reject(new Error(`${kind}: claude exited ${code}`)); return }
      try { resolve(parseStructuredAnswer(out, request.requested)) } catch (err) { reject(new Error(`${kind}: ${(err as Error).message}`, { cause: err })) }
    })
    // A child that dies before reading its prompt (killed, broken launcher) makes this write EPIPE; unheard, that
    // error is uncaught and ends the server. The exit status in 'close' already rejects this call with the cause.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => log.warn('central.helper.stdin_failed', `${kind}: prompt write to claude failed`, { kind, code: err.code ?? err.name }))
    child.stdin.end(req.prompt)
  })
}

/** Books one helper answer in the active ledger (none in tests/before boot). Lazy imports keep bun:sqlite out of node-env tests. */
export async function bookInLedger(kind: HelperKind, usage: HelperUsage): Promise<void> {
  const [{ activeLedgerRuntime }, { recordHelperUsage }] = await Promise.all([
    import('../../ledger/ledgerRuntimeState'), import('../../cost/costCapture'),
  ])
  const ledger = activeLedgerRuntime()
  if (ledger) recordHelperUsage(ledger.db, kind, usage)
}

/** Output-only call for helper `kind`; every answer's usage is booked (`book` is injectable for tests). */
export function createClaudeStructured(kind: HelperKind, opts: StructuredOptions & { book?: BookUsage } = {}): StructuredCall {
  const run = createStructuredRunner(kind, opts)
  const book = opts.book ?? bookInLedger
  return async (req, signal) => {
    const answer = await run(req, signal)
    // Booking never fails the helper: the answer is already paid for and useful.
    await Promise.resolve().then(() => book(kind, answer.usage)).catch((err: unknown) =>
      log.warn('central.helper.usage_book_failed', 'helper usage could not be booked', { kind, error: err instanceof Error ? err.message : String(err) }))
    return answer.output
  }
}

/** Runs `call` with a wall-clock cap; the abort reaches the child. */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`${what} timed out after ${timeoutMs}ms`)) }, timeoutMs)
  })
  try { return await Promise.race([run(controller.signal), timeout]) } finally { clearTimeout(timer) }
}

const isStringList = (v: unknown, maxItems: number, maxChars: number): v is string[] =>
  Array.isArray(v) && v.length <= maxItems && v.every((s) => typeof s === 'string' && s.length <= maxChars)

/** Strict schema check for objects whose fields are all string lists; returns null when any field is off. */
export function stringLists<K extends string>(value: unknown, keys: readonly K[], maxItems: number, maxChars: number): Record<K, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const out = {} as Record<K, string[]>
  for (const k of keys) {
    if (!isStringList(v[k], maxItems, maxChars)) return null
    out[k] = (v[k] as string[]).map((s) => s.trim()).filter((s) => s !== '')
  }
  return out
}

/** JSON schema of an object of string lists (the `--json-schema` the CLI enforces). */
export function stringListSchema(keys: readonly string[], maxItems: number, maxChars: number): object {
  const list = { type: 'array', maxItems, items: { type: 'string', maxLength: maxChars } }
  return { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, list])), required: [...keys], additionalProperties: false }
}
