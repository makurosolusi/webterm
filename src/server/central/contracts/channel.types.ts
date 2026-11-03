// Cross-WS contract: channel adapter and normalized events (RND/29b §4.11, RND/26 §3.3).
import type { Awaitable } from './tool.types'

/** Identifier of one bot/account of a channel kind (a channel may have several). */
export type AccountId = string

/** Static capabilities used to render and split output per channel. */
export interface ChannelCaps {
  maxText: number
  edit: boolean
  buttons: boolean
  threads: boolean
  stream: boolean
  groupMirror: boolean
}

/** Raw inbound request as seen by an adapter (webhook body plus lowercase headers). */
export interface InboundRequest {
  headers: Readonly<Record<string, string>>
  body: string
}

/** Normalized inbound event; replaces the Telegram-only message shape. */
export interface InboundEvent {
  kind: 'message' | 'callback'
  accountId: AccountId
  /** Provider event id (`update_id`); the idempotency key for the claim. */
  externalEventId: string
  chatId: string
  userId: string
  isGroup: boolean
  threadId?: string
  text: string
  /** Set when `kind` is `callback` (button press). */
  callbackId?: string
}

/** A button on a status card; `id` is opaque and resolved by the server. */
export interface OutboundAction {
  id: string
  label: string
}

/** Neutral outbound message; each adapter renders it to its provider format. */
export interface OutboundMessage {
  text: string
  card?: { title: string; status: string; actions: readonly OutboundAction[] }
  replyTo?: string
  threadKey?: string
}

/** Provider-specific payload produced by `render`; opaque outside the adapter. */
export type ProviderPayload = Readonly<Record<string, unknown>>

/** Outcome of one send; `retryAfterMs` honors provider rate limits. */
export interface SendResult {
  ok: boolean
  externalId?: string
  retryAfterMs?: number
  errorCode?: string
}

/** One channel kind; tokens come from the secret store and never appear in these types. */
export interface ChannelAdapter {
  /** `telegram`, `discord`, `webhook`, ... */
  readonly kind: string
  readonly caps: ChannelCaps
  /** Verifies signature/secret and normalizes; null when invalid or ignorable. Pure. */
  verify(req: InboundRequest): InboundEvent | null
  /** Renders a neutral message, escaping untrusted text and cutting to `caps.maxText`. */
  render(msg: OutboundMessage): ProviderPayload
  /** Sends through the given account. */
  send(accountId: AccountId, payload: ProviderPayload): Awaitable<SendResult>
}
