// Shared types and constants for the human-facing binding API (P3).
import type { ChannelBinding, ChannelRole } from './identity'

export type RouteResult = { status: number; body: unknown }

export const TELEGRAM_BINDINGS_PATH = '/api/channels/telegram/bindings'
export const TELEGRAM_BINDINGS_CHANNEL = 'telegram'
export const GROUP_ROLES: readonly ChannelRole[] = ['viewer', 'operator']
export const MAX_PROJECT_ID_CHARS = 200

export interface BindingStorePort {
  binding(channel: string, chatId: string): ChannelBinding | undefined
  bind(channel: string, chatId: string, binding: ChannelBinding): void
  unbind(channel: string, chatId: string): boolean
  listBindings(channel?: string): Array<{ channel: string; chatId: string; binding: ChannelBinding }>
}

export type BindingAction = 'list' | 'bind' | 'unbind'
export type BindingOutcome = 'ok' | 'invalid' | 'denied' | 'not_found' | 'error'

/** Optional observer hook. Contains no secret and no free text from the request body. */
export interface BindingAuditEvent {
  kind: 'channel.telegram.binding'
  action: BindingAction
  outcome: BindingOutcome
  reason?: string
  chatId?: string
  projectId?: string
  role?: string
}
export type BindingAudit = (event: BindingAuditEvent) => void

export interface TelegramBindingView {
  channel: typeof TELEGRAM_BINDINGS_CHANNEL
  chatId: string
  projectId: string
  role: ChannelRole
  userId?: string
}
