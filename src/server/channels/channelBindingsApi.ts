// Human-facing binding API (P3): GET/POST/DELETE `/api/channels/telegram/bindings`. Pure transport
// adapters around ChannelStore; root/human auth is the caller's job (index.ts does it before this
// runs). Nothing here auto-enrolls a chat: a conversation exists only after an explicit POST.
//
// Group chats are mirror/observe surfaces: they may bind `viewer` or `operator` only. Approval
// roles (`approver`, `owner`) require a private chat, because group identity is ambiguous.
// Typed RouteResult mirrors the other API modules; `null` means "not this route".
//
// This file is a barrel: the implementation lives in the sibling `channelBindings*.ts` modules.
export {
  GROUP_ROLES,
  MAX_PROJECT_ID_CHARS,
  TELEGRAM_BINDINGS_CHANNEL,
  TELEGRAM_BINDINGS_PATH,
  type BindingAction,
  type BindingAudit,
  type BindingAuditEvent,
  type BindingOutcome,
  type BindingStorePort,
  type RouteResult,
  type TelegramBindingView,
} from './channelBindingsTypes'
export { listTelegramBindings } from './channelBindingsList'
export { createTelegramBinding, deleteTelegramBinding } from './channelBindingsStore'
export { channelBindingsRoute } from './channelBindingsRoute'
