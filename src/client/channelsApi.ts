// Klien REST untuk channel Telegram (status, pending, bindings). Transport + token memakai
// `request` dari inboxTransport (header `x-webterm-token`, token tak pernah masuk URL/pesan error).
import { isAbortError, request } from './inboxTransport'
import { InboxApiError } from './inboxTypes'
import { CH } from './channelsLabels'

const BASE = '/api/channels/telegram'
/** Batas panjang project id; harus sama dengan MAX_PROJECT_ID_CHARS di server. */
export const MAX_PROJECT_ID_CHARS = 200
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export const CHANNEL_ROLES = ['viewer', 'operator', 'approver', 'owner'] as const
export type ChannelRole = (typeof CHANNEL_ROLES)[number]
/** Chat grup (id negatif) hanya boleh role ini — cermin GROUP_ROLES di server. */
export const GROUP_ROLES: readonly ChannelRole[] = ['viewer', 'operator']

export interface DirectionStatus {
  lastOk?: number
  lastError?: { at: number; message: string }
  okCount: number
  errorCount: number
}
export interface TelegramStatus {
  mode: 'poll' | 'webhook'
  botTokenSet: boolean
  webhookSecretSet: boolean
  pendingCount: number
  ingress: DirectionStatus
  egress: DirectionStatus
}
export interface PendingChat {
  chatId: string
  type: string
  firstSeen: number
  lastSeen: number
  count: number
}
export interface TelegramBinding {
  chatId: string
  projectId: string
  role: ChannelRole
  userId?: string
}

export { isAbortError }

/** Status channel; `null` = server menjawab 404 (channel nonaktif). */
export async function fetchStatus(signal?: AbortSignal): Promise<TelegramStatus | null> {
  try {
    return await request<TelegramStatus>(`${BASE}/status`, { signal })
  } catch (e) {
    if (e instanceof InboxApiError && e.status === 404) return null
    throw e
  }
}

/** Daftar chat yang belum ter-bind. */
export async function fetchPending(signal?: AbortSignal): Promise<PendingChat[]> {
  const body = await request<{ items?: PendingChat[] }>(`${BASE}/pending`, { signal })
  return Array.isArray(body.items) ? body.items : []
}

/** Daftar binding aktif. */
export async function fetchBindings(signal?: AbortSignal): Promise<TelegramBinding[]> {
  const body = await request<{ items?: TelegramBinding[] }>(`${BASE}/bindings`, { signal })
  return Array.isArray(body.items) ? body.items : []
}

/** Bind satu chat ke project dengan role. */
export async function bindChat(input: { projectId: string; chatId: string; role: ChannelRole }): Promise<void> {
  await request(`${BASE}/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** Abaikan satu chat pending. */
export async function ignorePending(chatId: string): Promise<void> {
  await request(`${BASE}/pending/${encodeURIComponent(chatId)}`, { method: 'DELETE' })
}

/** Hapus binding satu chat. */
export async function unbindChat(chatId: string): Promise<void> {
  await request(`${BASE}/bindings?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' })
}

/** Validasi project id seperti server; null = valid. */
export function projectIdProblem(value: string): string | null {
  const v = value.trim()
  return v === '' || v.length > MAX_PROJECT_ID_CHARS || CONTROL_CHARS.test(v) ? CH.projectIdInvalid : null
}

/** Pesan ringkas untuk UI; tidak pernah memuat URL, body, atau token. */
export function channelsErrorMessage(error: unknown): string {
  if (error instanceof InboxApiError) {
    if (error.status === 401 || error.status === 403) {
      return error.code === 'group_approval_role_denied' ? CH.errGroupRole : CH.errAuth
    }
    if (error.status === 404) return CH.errGone
    if (error.status === 400) return CH.errInvalid
    return CH.errGeneric
  }
  if (error instanceof TypeError) return CH.errNetwork
  return CH.errGeneric
}
