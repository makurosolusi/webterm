// Deteksi prasyarat eksternal kartu kemampuan (ES-09): Chromium, token bot, mesin agen siap (terpasang +
// login), dan nama bot Telegram. Probe mahal (preflight CLI, getMe) hanya jalan bila kemampuannya on.
import { createHash } from 'node:crypto'
import { detectChromium } from './browser/chromium.launch'
import { centralRuntimeKind, CENTRAL_RUNTIME_FLAG } from './central/runtime/runtimeFlag'
import { claudePreflightOf, freshClaudePreflight, runtimeReadiness } from './centralChatHealth'
import { PollApiError, callBotApi } from './channels/telegramPollApi'
import { resolveTelegramBotToken, type TelegramSenderFetch } from './channels/telegramSend'
import { isEnabled } from './featureCapabilities.runtime'
import { createLogger } from './logs'

const log = createLogger('capabilities')

/** Prasyarat yang terdeteksi; disuntik supaya `viewOf` tetap murni. `telegramBot` = "@nama" bila diketahui. */
export interface Detect { chromium: boolean; telegramToken: boolean; agentEngine: boolean; telegramBot?: string }

const GETME_TIMEOUT_MS = 5_000
/** Gagal getMe (jaringan) tidak diulang tiap GET; dicoba lagi setelah jeda ini. */
const GETME_RETRY_MS = 60_000

// Kunci cache = sidik token (bukan token): nama bot tetap sama selama tokennya sama.
const botNames = new Map<string, { name?: string; at: number }>()
const tokenId = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Catat nama bot yang sudah dipastikan `getMe` (mis. saat Hubungkan bot), supaya GET berikutnya tak memanggil lagi. */
export function rememberTelegramBot(token: string, name: string): void {
  botNames.set(tokenId(token.trim()), { name, at: Date.now() })
}

/** "@nama" bot untuk token di env, dari cache atau satu panggilan `getMe`; undefined bila tak bisa dipastikan. */
export async function telegramBotName(env: NodeJS.ProcessEnv, fetch: TelegramSenderFetch): Promise<string | undefined> {
  const token = resolveTelegramBotToken(env)
  if (token === undefined) return undefined
  const id = tokenId(token)
  const hit = botNames.get(id)
  if (hit && (hit.name !== undefined || Date.now() - hit.at < GETME_RETRY_MS)) return hit.name
  try {
    const me = await callBotApi({
      method: 'getMe', params: {}, token, fetch, signal: new AbortController().signal, timeoutMs: GETME_TIMEOUT_MS,
    })
    const username = (me as { username?: unknown } | null)?.username
    const name = typeof username === 'string' && username !== '' ? `@${username}` : undefined
    botNames.set(id, { name, at: Date.now() })
    return name
  } catch (err) {
    // Detail kartu hanya pelengkap: gagal = tanpa nama, dicoba lagi setelah GETME_RETRY_MS. Log jenis saja (tanpa token).
    botNames.set(id, { at: Date.now() })
    log.warn('capability.telegram_getme_failed', 'Cannot read bot name for the Telegram card', { kind: err instanceof PollApiError ? err.kind : 'unknown' })
    return undefined
  }
}

/** Opsi deteksi: `fresh` = periksa ulang eksplisit ("Periksa lagi"), lewati cache probe login untuk panggilan ini. */
export interface DetectOptions { fresh?: boolean }

/** Mesin agen Central siap dipakai: terpasang DAN login (preflight yang sama dengan `/api/central/health`). */
export async function agentEngineReady(env: NodeJS.ProcessEnv, opts: DetectOptions = {}): Promise<boolean> {
  const kind = centralRuntimeKind(env[CENTRAL_RUNTIME_FLAG])
  return (await runtimeReadiness(kind, opts.fresh ? freshClaudePreflight() : claudePreflightOf())).runtimeReady
}

/** Deteksi nyata untuk produksi. */
export async function defaultDetect(env: NodeJS.ProcessEnv, fetch: TelegramSenderFetch, opts: DetectOptions = {}): Promise<Detect> {
  const [agentEngine, telegramBot] = await Promise.all([
    isEnabled('central', env) ? agentEngineReady(env, opts) : Promise.resolve(false),
    isEnabled('telegram', env) ? telegramBotName(env, fetch) : Promise.resolve(undefined),
  ])
  return {
    chromium: detectChromium(env) !== null, telegramToken: resolveTelegramBotToken(env) !== undefined, agentEngine,
    ...(telegramBot ? { telegramBot } : {}),
  }
}
