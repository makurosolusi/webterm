// Managed Bots manager (RND/26 §3.2, WS-13): verify a bot token with `getMe`, keep it only in the
// SecretStore, and map projects to forum topics. The token never reaches the registry, logs, audit or
// any return value; callers get `username` and the token length only. Real Telegram is a manual test.
import { join } from 'node:path'
import { flagOn } from '../envFlag'
import { createFileSecretStore, type SecretStore } from '../envSecrets.store'
import { createLogger } from '../logs'
import { BOT_ACCOUNT_RE, botSecretKey, createManagedBotRegistry, topicKey, type ManagedBotRegistry } from './botManaged'
import { PollApiError, callBotApi } from './telegramPollApi'
import type { TelegramSenderFetch } from './telegramSend'

/** Feature flag (default OFF). Registered in the env registry by WS-19. */
export const CENTRAL_BOTS_FLAG = 'WEBTERM_CENTRAL_BOTS'
const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
const BOT_API_TIMEOUT_MS = 10_000
/** After a failed `createForumTopic` the chat is not retried for this long (group may not be a forum). */
export const TOPIC_RETRY_MS = 10 * 60 * 1000
const TOPIC_NAME_MAX = 128
const SECRETS_SUBDIR = 'secrets'
const REGISTRY_FILE = 'managed-bots.json'

const log = createLogger('channels')

/** Calls one Bot API method as `accountId`; throws `PollApiError` (message already redacted). */
export type BotCall = (accountId: string, method: string, params: Record<string, unknown>) => Promise<unknown>

export interface BotManagerDeps {
  secrets: SecretStore
  registry: ManagedBotRegistry
  fetch?: TelegramSenderFetch
  apiBase?: string
  now?: () => number
}

export interface ProposeInput { accountId: string; botToken: string; purpose: string }
export type ProposeResult =
  | { ok: true; bot: { accountId: string; botId: number; username: string; tokenLength: number } }
  | { ok: false; code: 'invalid_token' | 'conflict' | 'getme_failed' | 'not_a_bot' | 'store_failed' }

export interface TopicInput { accountId: string; chatId: string; projectId: string; projectName: string }
/** `fallback` true = no topic; send to the chat without `message_thread_id`. */
export interface TopicResult { threadId?: number; fallback: boolean }

export interface BotManager {
  readonly registry: ManagedBotRegistry
  /** Verifies the token with getMe, stores it in the SecretStore, registers the bot. Never returns the token. */
  propose(input: ProposeInput): Promise<ProposeResult>
  /** Bot API call as a registered, active bot; token read from the SecretStore per call. */
  call: BotCall
  /** Topic (message_thread_id) of a project in a chat; creates it once, falls back without throwing. */
  topicFor(input: TopicInput): Promise<TopicResult>
}

/** Builds the manager over injected storage and transport. */
export function createBotManager(deps: BotManagerDeps): BotManager {
  const now = deps.now ?? Date.now
  const fetchFn = deps.fetch ?? (globalThis.fetch as unknown as TelegramSenderFetch)
  const retryAt = new Map<string, number>()
  const api = (token: string, method: string, params: Record<string, unknown>): Promise<unknown> =>
    callBotApi({ method, params, token, apiBase: deps.apiBase, fetch: fetchFn, signal: new AbortController().signal, timeoutMs: BOT_API_TIMEOUT_MS })

  const call: BotCall = async (accountId, method, params) => {
    const bot = deps.registry.get(accountId)
    const token = bot?.state === 'active' ? deps.secrets.read(botSecretKey(accountId)) : null
    if (!token) throw new PollApiError('fatal', `bot ${accountId} is not available`)
    return api(token, method, params)
  }

  return {
    registry: deps.registry,
    call,
    async propose({ accountId, botToken, purpose }) {
      if (!BOT_ACCOUNT_RE.test(accountId) || !BOT_TOKEN_RE.test(botToken)) return { ok: false, code: 'invalid_token' }
      if (deps.registry.get(accountId)?.state === 'active') return { ok: false, code: 'conflict' }
      let me: { id?: unknown; is_bot?: unknown; username?: unknown }
      try {
        me = (await api(botToken, 'getMe', {})) as typeof me
      } catch (err) {
        log.warn('bots.getme_failed', `getMe failed for ${accountId}`, { accountId, kind: err instanceof PollApiError ? err.kind : 'unknown' })
        return { ok: false, code: 'getme_failed' }
      }
      if (me?.is_bot !== true || !Number.isSafeInteger(me.id) || typeof me.username !== 'string' || !me.username) return { ok: false, code: 'not_a_bot' }
      const bot = { accountId, botId: me.id as number, username: me.username, purpose, state: 'active' as const, createdAt: now(), topics: {} }
      try {
        deps.secrets.write(botSecretKey(accountId), botToken)
        deps.registry.put(bot)
      } catch (err) {
        // Roll the secret back so a half-registered bot never keeps a token nobody can see.
        try { deps.secrets.remove(botSecretKey(accountId)) } catch (cleanup) {
          log.error('bots.rollback_failed', `secret cleanup failed for ${accountId}`, { accountId, error: cleanup instanceof Error ? cleanup.message : 'unknown' })
        }
        log.error('bots.store_failed', `could not store bot ${accountId}`, { accountId, error: err instanceof Error ? err.message : 'unknown' })
        return { ok: false, code: 'store_failed' }
      }
      log.info('bots.registered', `managed bot ${accountId} registered`, { accountId, username: bot.username })
      return { ok: true, bot: { accountId, botId: bot.botId, username: bot.username, tokenLength: botToken.length } }
    },
    async topicFor({ accountId, chatId, projectId, projectName }) {
      const key = topicKey(chatId, projectId)
      const known = deps.registry.get(accountId)?.topics[key]
      if (known !== undefined) return { threadId: known, fallback: false }
      if ((retryAt.get(`${accountId}|${key}`) ?? 0) > now()) return { fallback: true }
      try {
        const created = (await call(accountId, 'createForumTopic', { chat_id: chatId, name: projectName.slice(0, TOPIC_NAME_MAX) })) as { message_thread_id?: unknown } | null
        const threadId = created?.message_thread_id
        if (!Number.isSafeInteger(threadId)) throw new PollApiError('transient', 'createForumTopic returned no thread id')
        deps.registry.setTopic(accountId, key, threadId as number)
        return { threadId: threadId as number, fallback: false }
      } catch (err) {
        retryAt.set(`${accountId}|${key}`, now() + TOPIC_RETRY_MS)
        log.warn('bots.topic_fallback', `no topic for project ${projectId}; sending without topic`, { accountId, projectId, kind: err instanceof PollApiError ? err.kind : 'unknown' })
        return { fallback: true }
      }
    },
  }
}

/** Mount point for `startChannelsRuntime`: null (nothing built, nothing read) unless the flag is on. */
export function mountBotManager(env: NodeJS.ProcessEnv, dir: string, overrides: Partial<BotManagerDeps> = {}): BotManager | null {
  if (!flagOn(env[CENTRAL_BOTS_FLAG])) return null
  return createBotManager({
    secrets: createFileSecretStore(join(dir, SECRETS_SUBDIR)),
    registry: createManagedBotRegistry(join(dir, 'channels', REGISTRY_FILE)),
    ...overrides,
  })
}
