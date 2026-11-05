// The consolidator's model call: one `claude -p` on haiku with the strict schema, no tools, no MCP, no user
// settings or hooks, no session file, per-call budget (structuredArgv, shared with the F5-c summarizer).
// Unlike that runner this one also returns the CLI's `usage`, because the daily token cap is booked from it.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { structuredArgv, SUMMARY_MODEL } from '../../central/context/claudeStructured'
import { claudeChildEnv } from '../../central/runtime/claudeOptions'
import type { RunUsage } from './consolidator.store'
import { centralClaudeLaunch } from '../../claudeLauncher/claudeLauncher'

const STDOUT_MAX = 512 * 1024

export interface ModelAnswer { output: unknown; usage: RunUsage }
/** Prompt + schema in, structured output + usage out. Tests inject a fake; nothing in a test reaches a model. */
export type ConsolidatorModel = (req: { prompt: string; schema: object }, signal: AbortSignal) => Promise<ModelAnswer>

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** `claude -p --output-format json` stdout → structured output + usage; throws on anything but success. */
export function parseModelAnswer(stdout: string): ModelAnswer {
  const o = JSON.parse(stdout) as {
    subtype?: string; is_error?: boolean; structured_output?: unknown; total_cost_usd?: unknown
    usage?: Record<string, unknown>; modelUsage?: Record<string, unknown>
  }
  if (o.subtype !== 'success' || o.is_error || o.structured_output === undefined || o.structured_output === null) {
    throw new Error(`consolidator: no structured output (${o.subtype ?? 'unknown'})`)
  }
  const u = o.usage ?? {}
  const cost = typeof o.total_cost_usd === 'number' && Number.isFinite(o.total_cost_usd) ? Math.round(o.total_cost_usd * 1e6) : null
  return {
    output: o.structured_output,
    usage: {
      input: num(u['input_tokens']), output: num(u['output_tokens']), cacheRead: num(u['cache_read_input_tokens']),
      cacheWrite: num(u['cache_creation_input_tokens']), costMicros: cost, model: Object.keys(o.modelUsage ?? {})[0] ?? SUMMARY_MODEL,
    },
  }
}

/** Real runner; `bin` is overridable so a test can point it at a stub script. */
export function createClaudeConsolidatorModel(opts: { bin?: string } = {}): ConsolidatorModel {
  return (req, signal) => new Promise<ModelAnswer>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('consolidator: aborted before start')); return }
    const [cmd, ...args] = opts.bin ? [opts.bin, ...structuredArgv(req.schema)] : [...centralClaudeLaunch().argv, ...structuredArgv(req.schema)]
    const child = spawn(cmd as string, args, { cwd: tmpdir(), env: claudeChildEnv(process.env), stdio: ['pipe', 'pipe', 'ignore'], shell: false })
    let out = ''
    const kill = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', kill, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { if (out.length < STDOUT_MAX) out += chunk })
    child.on('error', (err) => reject(new Error(`consolidator: claude spawn failed: ${err.message}`)))
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill)
      if (code !== 0) { reject(new Error(`consolidator: claude exited ${code}`)); return }
      try { resolve(parseModelAnswer(out)) } catch (err) { reject(err) }
    })
    child.stdin.end(req.prompt)
  })
}
