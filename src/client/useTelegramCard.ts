// State kartu Telegram: hubungkan token (write-only), daftar chat menunggu/tertaut, tautkan satu ketukan.
import { useCallback, useEffect, useRef, useState } from 'react'
import { bindChat, fetchBindings, fetchPending, ignorePending, unbindChat } from './channelsApi'
import type { PendingChat, TelegramBinding } from './channelsApi'
import { request } from './inboxTransport'
import { InboxApiError } from './inboxTypes'
import type { CapabilitiesResponse } from '../shared/featureCapabilities'
import { TG, connectErrorText } from './telegramCardLabels'

/** Jeda penyegaran daftar chat menunggu saat tab terlihat. */
export const PENDING_POLL_MS = 5000
const CAPABILITIES_PATH = '/api/capabilities'
const TELEGRAM_ID = 'telegram'

/** Kirim token ke server; token hanya hidup di body request ini. */
async function postConnect(token: string): Promise<{ bot: string }> {
  return request<{ bot: string }>(`${CAPABILITIES_PATH}/${TELEGRAM_ID}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

async function postDisable(): Promise<void> {
  await request(`${CAPABILITIES_PATH}/${TELEGRAM_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
}

/** Tersambung = kemampuan telegram berstatus 'on' (token tersimpan saja tidak cukup: Putuskan mematikannya). */
async function fetchTelegramOn(): Promise<boolean> {
  const res = await request<CapabilitiesResponse>(CAPABILITIES_PATH)
  return res.capabilities.find((c) => c.id === TELEGRAM_ID)?.status === 'on'
}

/** Chat grup berid negatif -> viewer; privat -> owner (KE-10). */
export const roleFor = (chatId: string): 'viewer' | 'owner' => (chatId.startsWith('-') ? 'viewer' : 'owner')

export function useTelegramCard(projectId: string) {
  const [token, setToken] = useState('')
  const [connected, setConnected] = useState(false)
  const [bot, setBot] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingChat[]>([])
  const [bindings, setBindings] = useState<TelegramBinding[]>([])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const refresh = useCallback(async () => {
    try {
      const on = await fetchTelegramOn()
      if (!alive.current) return
      setConnected(on)
      if (!on) { setPending([]); setBindings([]); setBot(null); return }
      const [p, b] = await Promise.all([fetchPending(), fetchBindings()])
      if (!alive.current) return
      setPending(p)
      setBindings(b)
    } catch {
      // Segarkan latar gagal (jaringan putus): tampilan terakhir dipertahankan, percobaan berikutnya jalan sendiri.
    }
  }, [])

  useEffect(() => {
    void refresh()
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = (): void => { if (timer !== null) { clearInterval(timer); timer = null } }
    const sync = (): void => {
      stop()
      if (document.visibilityState === 'visible') timer = setInterval(() => void refresh(), PENDING_POLL_MS)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => { stop(); document.removeEventListener('visibilitychange', sync) }
  }, [refresh])

  const connect = useCallback(async () => {
    const sent = token.trim()
    if (sent === '') return
    setToken('') // write-only: dikosongkan sebelum request, nilai tak tersisa di state.
    setError(null)
    setConnecting(true)
    try {
      const res = await postConnect(sent)
      if (!alive.current) return
      setBot(res.bot)
      await refresh()
    } catch (e) {
      if (alive.current) setError(connectErrorText(e instanceof InboxApiError ? e.code : ''))
    } finally {
      if (alive.current) setConnecting(false)
    }
  }, [token, refresh])

  const act = useCallback(async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
      await refresh()
    } catch {
      if (alive.current) setError(TG.errAction)
    }
  }, [refresh])

  return {
    token, setToken, connected, bot, connecting, error, pending, bindings, connect,
    disconnect: () => act(async () => { await postDisable(); setBot(null) }),
    link: (c: PendingChat) => act(() => bindChat({ projectId, chatId: c.chatId, role: roleFor(c.chatId) })),
    ignore: (c: PendingChat) => act(() => ignorePending(c.chatId)),
    unbind: (b: TelegramBinding) => act(() => unbindChat(b.chatId)),
  }
}
