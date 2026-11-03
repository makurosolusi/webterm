// Registry of managed Telegram bots (RND/26 §3.4, P10: one bot per account, one topic per project).
// Only non-secret metadata lives here; the token is in the SecretStore under `botSecretKey`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Account ids are lowercase slugs so they map 1:1 onto a SecretStore key (`^[A-Z][A-Z0-9_]{0,63}$`). */
export const BOT_ACCOUNT_RE = /^[a-z][a-z0-9_]{0,31}$/
const REGISTRY_FILE_MODE = 0o600
const REGISTRY_DIR_MODE = 0o700
export const BOT_LIST_DEFAULT = 20
export const BOT_LIST_MAX = 50

export type ManagedBotState = 'active' | 'revoked'

/** One managed bot; `topics` maps `topicKey(chatId, projectId)` to a forum `message_thread_id`. */
export interface ManagedBot {
  accountId: string
  botId: number
  username: string
  purpose: string
  state: ManagedBotState
  createdAt: number
  topics: Record<string, number>
}

/** SecretStore key holding the bot token of `accountId`. */
export function botSecretKey(accountId: string): string {
  return `CHBOT_${accountId.toUpperCase()}_TOKEN`
}

/** Key of the topic for one project inside one chat. */
export function topicKey(chatId: string, projectId: string): string {
  return `${chatId}|${projectId}`
}

export interface ManagedBotRegistry {
  get(accountId: string): ManagedBot | undefined
  /** Paginated, oldest first. */
  list(page?: { limit?: number; offset?: number }): ManagedBot[]
  put(bot: ManagedBot): void
  setTopic(accountId: string, key: string, threadId: number): boolean
  remove(accountId: string): boolean
}

function isBot(value: unknown): value is ManagedBot {
  const v = value as Partial<ManagedBot> | null
  return typeof v === 'object' && v !== null && typeof v.accountId === 'string' && BOT_ACCOUNT_RE.test(v.accountId)
    && Number.isSafeInteger(v.botId) && typeof v.username === 'string' && typeof v.purpose === 'string'
    && (v.state === 'active' || v.state === 'revoked') && typeof v.createdAt === 'number'
    && typeof v.topics === 'object' && v.topics !== null
}

/** Registry in memory, persisted atomically to `file` (0600) when given. A corrupt file throws; it is never reset. */
export function createManagedBotRegistry(file?: string): ManagedBotRegistry {
  const bots = new Map<string, ManagedBot>()
  if (file && existsSync(file)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`managed bot registry unreadable (${err instanceof Error ? err.name : 'error'})`)
    }
    if (!Array.isArray(parsed) || !parsed.every(isBot)) throw new Error('managed bot registry has an unexpected shape')
    for (const bot of parsed) bots.set(bot.accountId, bot)
  }
  const save = (): void => {
    if (!file) return
    mkdirSync(dirname(file), { recursive: true, mode: REGISTRY_DIR_MODE })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify([...bots.values()]), { mode: REGISTRY_FILE_MODE })
    renameSync(tmp, file)
  }
  const copy = (bot: ManagedBot): ManagedBot => ({ ...bot, topics: { ...bot.topics } })
  return {
    get: (id) => { const b = bots.get(id); return b ? copy(b) : undefined },
    list(page = {}) {
      const limit = Math.min(Math.max(page.limit ?? BOT_LIST_DEFAULT, 1), BOT_LIST_MAX)
      return [...bots.values()].slice(page.offset ?? 0, (page.offset ?? 0) + limit).map(copy)
    },
    put(bot) { bots.set(bot.accountId, copy(bot)); save() },
    setTopic(id, key, threadId) {
      const bot = bots.get(id)
      if (!bot) return false
      bot.topics[key] = threadId
      save()
      return true
    },
    remove(id) { const had = bots.delete(id); if (had) save(); return had },
  }
}
