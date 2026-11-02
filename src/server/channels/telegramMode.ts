// Telegram ingress mode (poll vs webhook). Its own module so channelsRuntime and the poll wiring
// can both depend on it without importing each other.
import { resolveTelegramBotToken } from './telegramSend'

export const TELEGRAM_MODE_ENV = 'WEBTERM_TELEGRAM_MODE'
export type TelegramMode = 'poll' | 'webhook'

/**
 * Ingress mode. Explicit `poll`/`webhook` wins; unset (or unsupported) means `poll` when a bot
 * token exists, else `webhook` (the legacy behavior, which needs no token to receive). Pass
 * `warn=false` for a second, silent resolution of the same env.
 */
export function resolveTelegramMode(env: NodeJS.ProcessEnv = process.env, warn = true): TelegramMode {
  const raw = (env[TELEGRAM_MODE_ENV] ?? '').trim().toLowerCase()
  if (raw === 'poll' || raw === 'webhook') return raw
  if (raw !== '' && warn) {
    console.warn(`telegram channel: unsupported ${TELEGRAM_MODE_ENV} value ignored; supported: poll, webhook`)
  }
  return resolveTelegramBotToken(env) ? 'poll' : 'webhook'
}
