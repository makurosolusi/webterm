// Test-only: a scripted stand-in for the SDK `Query` plus SDK message fixtures. Never imported by
// production code; no real Claude process is involved.
import type { PermissionMode, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type Item = { m: SDKMessage } | { err: Error } | { end: true }

export class FakeQuery implements AsyncIterable<SDKMessage> {
  readonly prompts: SDKUserMessage[] = []
  readonly modes: PermissionMode[] = []
  interrupts = 0
  closed = false
  private items: Item[] = []
  private wake?: () => void

  constructor(prompt: AsyncIterable<SDKUserMessage>) {
    void (async () => { for await (const p of prompt) this.prompts.push(p) })()
  }

  emit(...ms: SDKMessage[]): void { this.push(...ms.map((m) => ({ m }))) }
  fail(err: Error): void { this.push({ err }) }
  end(): void { this.push({ end: true }) }

  async interrupt(): Promise<void> { this.interrupts++ }
  async setPermissionMode(m: PermissionMode): Promise<void> { this.modes.push(m) }
  close(): void { this.closed = true; this.end() }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const it = this.items.shift()
      if (!it) {
        await new Promise<void>((r) => { this.wake = r })
        continue
      }
      if ('end' in it) return
      if ('err' in it) throw it.err
      yield it.m
    }
  }

  /** The session only iterates and calls interrupt/setPermissionMode/close; the rest of Query is unused. */
  asQuery(): Query { return this as unknown as Query }

  private push(...items: Item[]): void {
    this.items.push(...items)
    const w = this.wake
    this.wake = undefined
    w?.()
  }
}

/** Fixtures carry only the fields the mapper/session read; the cast skips the unused SDK fields. */
const msg = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage

export const fx = {
  init: (sessionId = 's-1', model = 'claude-test', permissionMode = 'default'): SDKMessage => msg({
    type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode,
    slash_commands: ['compact'], capabilities: ['interrupt'], claude_code_version: '2.1.300',
  }),
  status: (fields: Record<string, unknown>): SDKMessage => msg({ type: 'system', subtype: 'status', status: null, ...fields }),
  retry: (attempt: number, delayMs: number): SDKMessage => msg({ type: 'system', subtype: 'api_retry', attempt, retry_delay_ms: delayMs }),
  messageStart: (id: string): SDKMessage => msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } }),
  textDelta: (text: string, parent: string | null = null): SDKMessage =>
    msg({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }),
  thinkingDelta: (thinking: string): SDKMessage =>
    msg({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } } }),
  assistant: (id: string, content: unknown[], parent: string | null = null): SDKMessage =>
    msg({ type: 'assistant', parent_tool_use_id: parent, message: { id, content } }),
  toolResult: (toolUseId: string, content: unknown, isError = false, parent: string | null = null): SDKMessage =>
    msg({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } }),
  result: (o: { subtype?: string; cost?: number; isError?: boolean; denials?: number } = {}): SDKMessage => msg({
    type: 'result', subtype: o.subtype ?? 'success', total_cost_usd: o.cost ?? 0.01, duration_ms: 1200,
    is_error: o.isError ?? false, usage: { input_tokens: 10, output_tokens: 5 },
    permission_denials: Array.from({ length: o.denials ?? 0 }, (_, n) => ({ tool_name: 'Bash', tool_use_id: `d-${n}`, tool_input: {} })),
  }),
}
