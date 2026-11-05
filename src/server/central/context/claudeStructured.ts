// One `claude -p` call on a small model with a strict JSON schema, for the summaries of F5-c (checkpoint
// summarizer, handoff card narrative, morning brief narrative). Copied from the proven policy classifier
// (policy/policy.classifier.claude.ts): structured outputs (`structured_output`, subtype `success`), no tools,
// no MCP, no user settings/hooks, no session file, per-call budget, hourly cap; the caller's abort kills the child.
// ponytail: the classifier keeps its own copy; fold it onto this runner when that file is next touched.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { claudeChildEnv } from '../runtime/claudeOptions'
import { claudeEnv } from '../../claudeProvider/claudeProvider.store'
import { centralClaudeLaunch } from '../../claudeLauncher/claudeLauncher'

export const SUMMARY_MODEL = 'haiku'
export const SUMMARY_BUDGET_USD = 0.05
export const SUMMARY_MAX_PER_HOUR = 60
const MAX_TURNS = 3
const STDOUT_MAX = 512 * 1024
const HOUR_MS = 3_600_000

/** The model port: prompt + schema in, the validated-by-the-CLI JSON value out. Tests inject a fake. */
export type StructuredCall = (req: { prompt: string; schema: object }, signal: AbortSignal) => Promise<unknown>

/** `structured_output` of `claude -p --output-format json` stdout; throws on anything else. */
export function parseStructuredOutput(stdout: string): unknown {
  const out = JSON.parse(stdout) as { subtype?: string; is_error?: boolean; structured_output?: unknown }
  if (out.subtype !== 'success' || out.is_error || out.structured_output === undefined || out.structured_output === null) {
    throw new Error(`no structured output (${out.subtype ?? 'unknown'})`)
  }
  return out.structured_output
}

export function structuredArgv(schema: object, model = SUMMARY_MODEL): string[] {
  return ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--model', model,
    '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence',
    '--max-turns', String(MAX_TURNS), '--max-budget-usd', String(SUMMARY_BUDGET_USD)]
}

/** `claude -p` runner; `bin` is overridable so tests never reach a real model. */
export function createClaudeStructured(opts: { bin?: string; now?: () => number } = {}): StructuredCall {
  const now = opts.now ?? Date.now
  const calls: number[] = []
  return (req, signal) => new Promise<unknown>((resolve, reject) => {
    const at = now()
    while (calls.length && at - calls[0]! >= HOUR_MS) calls.shift()
    if (calls.length >= SUMMARY_MAX_PER_HOUR) { reject(new Error('hourly summary cap reached')); return }
    if (signal.aborted) { reject(new Error('aborted before start')); return }
    calls.push(at)
    const [cmd, ...args] = opts.bin ? [opts.bin, ...structuredArgv(req.schema)] : [...centralClaudeLaunch().argv, ...structuredArgv(req.schema)]
    const child = spawn(cmd as string, args, { cwd: tmpdir(), env: claudeEnv(claudeChildEnv(process.env)), stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    let out = ''
    const kill = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (out.length < STDOUT_MAX) out += chunk })
    child.on('error', (err) => reject(new Error(`claude spawn failed: ${err.message}`)))
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill)
      if (code !== 0) { reject(new Error(`claude exited ${code}`)); return }
      try { resolve(parseStructuredOutput(out)) } catch (err) { reject(err) }
    })
    child.stdin.end(req.prompt)
  })
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
