// The streaming input of an agent chat Query: user turns pushed by the session, read by the SDK.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** Pushable async iterable of user turns (the Query's streaming input). */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private q: SDKUserMessage[] = []
  private wake?: () => void
  private done = false
  push(m: SDKUserMessage): void { this.q.push(m); this.wake?.() }
  end(): void { this.done = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.q.length) yield this.q.shift() as SDKUserMessage
      if (this.done) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = undefined
    }
  }
}
