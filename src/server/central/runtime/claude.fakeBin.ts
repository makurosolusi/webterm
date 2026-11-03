// Test support: writes a fake `claude` executable (a Node `.mjs`) and builds stream-json
// records for it. [BT] The record shapes are our own fixtures of the documented stream-json
// format, not recordings of a real CLI (confirmed only at GATE-S). No network, no real claude.
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeEvent, TurnInput } from './centralRuntime'

let counter = 0

/** Source prelude every fake starts with: `emit(record)` and `readStdin()`. */
export const PRELUDE = `import fs from 'node:fs'
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n')
const readStdin = () => fs.readFileSync(0, 'utf8')
`

/** Writes an executable fake into `dir` and returns its path. */
export function writeFakeClaude(dir: string, body: string): string {
  counter += 1
  const file = join(dir, `fake-claude-${counter}.mjs`)
  writeFileSync(file, `#!/usr/bin/env node\n${PRELUDE}${body}\n`, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

/** Source that records argv, env keys, cwd and stdin to `file` (JSON). */
export function captureSource(file: string): string {
  return `fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({
    argv: process.argv.slice(2), envKeys: Object.keys(process.env), cwd: process.cwd(), stdin: readStdin(),
  }))\n`
}

/** Source that emits each record in order. */
export function emitSource(records: readonly unknown[]): string {
  return `for (const r of ${JSON.stringify(records)}) emit(r)\n`
}

export const initRecord = (extra: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', session_id: 'sess-1', tools: [], mcp_servers: [], ...extra,
})

export const deltaRecord = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})

export const assistantRecord = (
  id: string, text: string, extra: Record<string, unknown> = {}, usage: Record<string, number> = {}
) => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5, ...usage } },
  ...extra,
})

export const resultRecord = (extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', total_cost_usd: 0.00025,
  duration_ms: 1200,
  usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
  ...extra,
})

/** A complete successful conversation: init, two deltas, the full assistant message, result. */
export const successRecords = (): unknown[] => [
  initRecord(), deltaRecord('Hello '), deltaRecord('world'), assistantRecord('m1', 'Hello world'), resultRecord(),
]

/** Minimal valid `TurnInput` for tests. */
export const turnInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  conversationId: 'central:global', turnId: 't1', text: 'hello', history: [], tools: [], limits: {}, ...overrides,
})

/** Collects emitted events in order. */
export function recorder(): { events: RuntimeEvent[]; emit: (event: RuntimeEvent) => void } {
  const events: RuntimeEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

/** Polls until `check` is true or `timeoutMs` passes. */
export async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** True when a process with this pid still exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
