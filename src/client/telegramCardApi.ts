// REST kartu Telegram: kemampuan (on/off + detail), token tersimpan (ada/tidak, tanpa nilai),
// hubungkan, nyala/mati, dan tautan pairing sekali pakai. Token hanya pernah di body `postConnect`.
import { request } from './inboxTransport'
import type { CapabilitiesResponse, CapabilityStatus } from '../shared/featureCapabilities'
import type { EnvStateV2 } from '../shared/envSettings.contract'

const CAPABILITIES_PATH = '/api/capabilities'
const TELEGRAM_ID = 'telegram'
/** Nama kunci (bukan nilai) token bot, cermin TELEGRAM_BOT_TOKEN_ENV_NAMES di server. */
const TOKEN_KEYS = ['WEBTERM_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']
const JSON_HEADERS = { 'Content-Type': 'application/json' }

export interface TelegramView { status: CapabilityStatus | 'missing'; detail?: string }
export interface PairingLink { bot: string; link: string; projectId: string; projectName: string; expiresAt: number }

export async function fetchTelegramView(): Promise<TelegramView> {
  const res = await request<CapabilitiesResponse>(CAPABILITIES_PATH)
  const v = res.capabilities.find((c) => c.id === TELEGRAM_ID)
  return v ? { status: v.status, ...(v.detail ? { detail: v.detail } : {}) } : { status: 'missing' }
}

/** True bila token bot masih tersimpan di server (hanya `secretSet`, nilai tak pernah dikirim). */
export async function fetchTokenStored(): Promise<boolean> {
  const res = await request<EnvStateV2>('/api/settings/env')
  return res.entries.some((e) => TOKEN_KEYS.includes(e.key) && e.secretSet === true)
}

/** Kirim token ke server; token hanya hidup di body request ini. */
export function postConnect(token: string): Promise<{ bot: string }> {
  return request<{ bot: string }>(`${CAPABILITIES_PATH}/${TELEGRAM_ID}/connect`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token }),
  })
}

/** Nyalakan/matikan bot; menyalakan memakai token yang sudah tersimpan di server. */
export async function postEnabled(enabled: boolean): Promise<TelegramView['status']> {
  const res = await request<CapabilitiesResponse>(`${CAPABILITIES_PATH}/${TELEGRAM_ID}`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled }),
  })
  return res.capabilities?.find((c) => c.id === TELEGRAM_ID)?.status ?? 'missing'
}

const FORWARDING_PATH = '/api/channels/telegram/forwarding'

/** Menit semua tab harus away sebelum kabar agent diteruskan ke Telegram (0 = mati). */
export async function fetchForwarding(): Promise<number> {
  return (await request<{ awayMinutes: number }>(FORWARDING_PATH)).awayMinutes
}

export async function putForwarding(awayMinutes: number): Promise<number> {
  const res = await request<{ awayMinutes: number }>(FORWARDING_PATH, {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ awayMinutes }),
  })
  return res.awayMinutes
}

/**
 * Detak kehadiran tab untuk penerusan desktop -> Telegram: kirim saat tab terlihat (dan periodik
 * selama terlihat), bersama daftar workspace yang di-mute (osNotify prefs).
 */
export async function postPresence(visible: boolean, muted: readonly string[]): Promise<void> {
  await request<unknown>('/api/channels/presence', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ visible, muted }),
  })
}

/** Tautan `https://t.me/<bot>?start=<kode>` sekali pakai untuk proyek ini. */
export function postPairing(projectId: string): Promise<PairingLink> {
  return request<PairingLink>('/api/channels/telegram/pairing', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ projectId }),
  })
}
