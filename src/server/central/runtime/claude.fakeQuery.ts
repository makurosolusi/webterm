// Test-only: a scripted stand-in for the Agent SDK `query()` that ClaudeRuntime injects (`options.query`).
// Records the options and the user message of every call and plays scripted SDK messages. Never imported
// by production code; no Claude process is involved.
import type { HookEvent, HookInput, HookJSONOutput, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CentralQuery } from './claudeOptions'

/** One `query()` call as the runtime made it. */
export interface FakeCall {
  options: Options
  /** The user message, once the runtime's prompt was read (the fake reads it before playing). */
  message?: SDKUserMessage
  /** Its plain prompt (string content) or text blocks joined. */
  text: string
  /** `close()` was called or the abort controller fired. */
  closed: boolean
}

/** Records to emit, or a script that may throw (a failed child) or never end (a hung child). */
export type FakePlay = readonly unknown[] | ((call: FakeCall) => AsyncIterable<unknown> | Iterable<unknown>)

const textOf = (m: SDKUserMessage): string => {
  const c = m.message.content
  if (typeof c === 'string') return c
  return c.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/** A fake `query()`; every call plays `play` (a function sees its own call). */
export function fakeQuery(play: FakePlay): { query: CentralQuery; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const query: CentralQuery = ({ prompt, options }) => {
    const call: FakeCall = { options, text: '', closed: false }
    calls.push(call)
    let wake: () => void = () => undefined
    const stopped = new Promise<IteratorResult<unknown>>((resolve) => { wake = () => resolve({ done: true, value: undefined }) })
    const close = (): void => { call.closed = true; wake() }
    options.abortController?.signal.addEventListener('abort', close, { once: true })
    const messages = (async function* () {
      for await (const m of prompt) {
        call.message = m
        call.text = textOf(m)
        break
      }
      yield* (typeof play === 'function' ? play(call) : play)
    })()
    // A stopped query ends its iteration at once, as the SDK does after close().
    const iterator: AsyncIterator<unknown> = { next: () => Promise.race([messages.next(), stopped]) }
    return { [Symbol.asyncIterator]: () => iterator, close, interrupt: async () => close() } as unknown as Query
  }
  return { query, calls }
}

/** A script that never ends on its own after `records` (a hung child). */
export function hang(records: readonly unknown[] = []): FakePlay {
  return async function* () {
    yield* records
    await new Promise<never>(() => undefined)
  }
}

/** Runs the registered SDK hooks of `event` whose matcher equals `match`, as the CLI would, and returns their outputs. */
export async function fireHook(options: Options, event: HookEvent, match: string, input: Record<string, unknown>): Promise<HookJSONOutput[]> {
  const outputs: HookJSONOutput[] = []
  for (const matcher of options.hooks?.[event] ?? []) {
    if (matcher.matcher !== undefined && matcher.matcher !== match) continue
    for (const hook of matcher.hooks) outputs.push(await hook({ hook_event_name: event, ...input } as HookInput, undefined, { signal: new AbortController().signal }))
  }
  return outputs
}
