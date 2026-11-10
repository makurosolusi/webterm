// Test support: writes a fake `claude` executable (a Node `.mjs`) that the real Agent SDK `query()` drives
// through the spawn hook, and builds the SDK/stream-json records both it and claude.fakeQuery.ts play.
// [BT] The record shapes are our own fixtures of the documented format, not recordings of a real CLI
// (confirmed only at GATE-S). No network, no real claude.
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeEvent, TurnInput } from './centralRuntime'

let counter = 0

/**
 * Source prelude every fake starts with: `emit(record)`, `readStdin()` (the SDK's initialize request and the
 * user message, as JSON lines; it returns once the user message is in, like the real CLI, because with
 * `options.hooks` the SDK keeps stdin open until the run's result) and `flag(name)` (the SDK passes `--name=value`).
 */
const PRELUDE = `import fs from 'node:fs'
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n')
const readStdin = () => {
  const chunks = []
  const chunk = Buffer.alloc(65536)
  for (;;) {
    const n = fs.readSync(0, chunk, 0, chunk.length, null)
    if (n === 0) return Buffer.concat(chunks).toString('utf8')
    chunks.push(Buffer.from(chunk.subarray(0, n)))
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.endsWith('\\n') && text.includes('"type":"user"')) return text
  }
}
const flag = (name) => process.argv.find((a) => a.startsWith(name + '='))?.slice(name.length + 1)
`

/** Writes an executable fake into `dir` and returns its path. */
export function writeFakeClaude(dir: string, body: string): string {
  counter += 1
  const file = join(dir, `fake-claude-${counter}.mjs`)
  writeFileSync(file, `#!/usr/bin/env node\n${PRELUDE}${body}\n`, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
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

/** Assistant message calling one MCP tool (shape of a real Claude Code 2.1.318 run). */
export const toolUseRecord = (messageId: string, id: string, name: string, input: unknown = {}) => ({
  type: 'assistant',
  message: { id: messageId, content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } },
})

/** The `user` record Claude Code writes after the MCP server answered. */
export const toolResultRecord = (toolUseId: string, content: unknown, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
})

export const resultRecord =(extra: Record<string, unknown> = {}) => ({
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
