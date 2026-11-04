// Claude Code channels adapter (K2 transport #1) — STUB, OFF by default.
//
// Channels (research preview, https://code.claude.com/docs/en/channels-reference) push events into
// an open session through an MCP server with the `claude/channel` capability. Custom channels still
// need `--dangerously-load-development-channels`, which breaks zero-config (A2), so the outbox does
// not select this transport until it ships without that flag. Flip the flag AND implement `send`
// together; until then `available()` is false and the outbox uses hook additionalContext / typed PTY.
import type { OutboxMessage } from './outboxStore'

/** Off until Claude channels work without a dangerous flag (PLAN/01-arsitektur.md K2). */
export const CHANNELS_TRANSPORT_ENABLED = false

export interface ChannelAdapter {
  /** Can this node receive a channel event right now? */
  available(nodeId: string): boolean
  send(nodeId: string, message: OutboxMessage): Promise<void>
}

/** The adapter the runtime installs; undefined while the flag is off. */
export function claudeChannelAdapter(): ChannelAdapter | undefined {
  if (!CHANNELS_TRANSPORT_ENABLED) return undefined
  return {
    available: () => false, // TODO(outbox-channel): detect a session started with the webterm channel server — PLAN K2
    send: async (nodeId) => { throw new Error(`outbox.channel: channel transport not implemented (node ${nodeId})`) },
  }
}
