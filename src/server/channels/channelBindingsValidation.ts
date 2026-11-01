// Input cleaning and response helpers for the binding API. No store access, no I/O.
import { CHANNEL_ROLES, type ChannelBinding, type ChannelRole } from './identity'
import {
  TELEGRAM_BINDINGS_CHANNEL,
  type BindingAudit,
  type BindingAuditEvent,
  type RouteResult,
  type TelegramBindingView,
} from './channelBindingsTypes'

export const MAX_ID_CHARS = 32
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function emit(audit: BindingAudit | undefined, event: BindingAuditEvent): void {
  if (!audit) return
  try {
    audit(event)
  } catch {
    // Observability must never turn a successful bind/unbind into an error response.
  }
}

export function fail(status: number, error: string): RouteResult {
  return { status, body: { error } }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty, bounded, no control characters. Values are stored and later echoed to the UI. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || CONTROL_CHARS.test(trimmed)) return null
  return trimmed
}

/**
 * Provider ids stay strings so 64-bit chat/user ids survive JSON. A JSON number is accepted only
 * when it is a safe integer; anything larger must arrive as a string.
 */
export function cleanId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null
  }
  const text = cleanText(value, MAX_ID_CHARS)
  return text !== null && /^-?\d+$/.test(text) ? text : null
}

export function isChannelRole(value: unknown): value is ChannelRole {
  return typeof value === 'string' && (CHANNEL_ROLES as readonly string[]).includes(value)
}

/** Telegram group/supergroup ids are negative; an explicit `isGroup` can also mark one. */
export function isGroupChat(chatId: string, declared: unknown): boolean {
  return chatId.startsWith('-') || declared === true
}

export function view(chatId: string, binding: ChannelBinding): TelegramBindingView {
  return {
    channel: TELEGRAM_BINDINGS_CHANNEL,
    chatId,
    projectId: binding.projectId,
    role: binding.role,
    ...(binding.userId === undefined ? {} : { userId: binding.userId }),
  }
}
