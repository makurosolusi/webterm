// Hubungkan bot Telegram dari satu token (ES-07): validasi bentuk -> getMe lewat egress yang ada ->
// BARU simpan token dan nyalakan kemampuan. Token ditolak = tidak ada yang berubah. Token tidak
// pernah masuk log, galat, atau hasil (callBotApi sudah meredaksi; di sini hanya alasan statis).
import type { SecretStore } from '../envSecrets.store'
import { BOT_TOKEN_SHAPE } from '../envRegistry.channels'
import { createLogger } from '../logs'
import { TELEGRAM_TOKEN_ENV } from './telegram'
import { PollApiError, callBotApi } from './telegramPollApi'
import type { TelegramSenderFetch } from './telegramSend'

const log = createLogger('channels.telegram')

/** Username bot Telegram: 5-32 karakter huruf/angka/underscore. */
const BOT_USERNAME_SHAPE = /^[A-Za-z0-9_]{5,32}$/
export const TELEGRAM_CONNECT_TIMEOUT_MS = 10_000

export type ConnectFailure = 'invalid_token_shape' | 'token_rejected' | 'unreachable' | 'save_failed' | 'enable_failed'
export type ConnectResult = { ok: true; bot: string } | { ok: false; reason: ConnectFailure }

export interface ConnectDeps {
  token: string
  fetch: TelegramSenderFetch
  store: SecretStore
  /**
   * Nyalakan kemampuan `telegram` dan terapkan token ke env (dipasang ES-09). Dipanggil HANYA
   * setelah token tersimpan; galatnya memberi `enable_failed` dan token tetap tersimpan.
   */
  enable?: () => void | Promise<void>
  apiBase?: string
  timeoutMs?: number
}

function fail(reason: ConnectFailure): ConnectResult {
  log.warn('telegram.connect.failed', 'telegram connect failed', { reason })
  return { ok: false, reason }
}

/** Periksa token ke Telegram (`getMe`); simpan + nyalakan hanya bila diterima. Tidak pernah melempar. */
export async function connectTelegram(deps: ConnectDeps): Promise<ConnectResult> {
  const token = deps.token.trim()
  if (!BOT_TOKEN_SHAPE.test(token)) return fail('invalid_token_shape')

  let username: unknown
  try {
    const me = await callBotApi({
      method: 'getMe', params: {}, token, apiBase: deps.apiBase, fetch: deps.fetch,
      signal: new AbortController().signal, timeoutMs: deps.timeoutMs ?? TELEGRAM_CONNECT_TIMEOUT_MS,
    })
    username = (me as { username?: unknown } | null)?.username
  } catch (err) {
    // 401/404 = token salah (fatal); sisanya (jaringan, timeout, 5xx, 429) = tak terjangkau.
    return fail(err instanceof PollApiError && err.kind === 'fatal' ? 'token_rejected' : 'unreachable')
  }
  // Jawaban ok tanpa username sah tak bisa dipastikan sebagai bot: jangan simpan apa pun.
  if (typeof username !== 'string' || !BOT_USERNAME_SHAPE.test(username)) return fail('unreachable')

  try {
    deps.store.write(TELEGRAM_TOKEN_ENV, token)
  } catch {
    return fail('save_failed') // pesan store memuat nama kunci saja, tapi tak perlu diteruskan
  }
  try {
    await deps.enable?.()
  } catch {
    return fail('enable_failed')
  }
  log.info('telegram.connect.ok', 'telegram connected')
  return { ok: true, bot: `@${username}` }
}
