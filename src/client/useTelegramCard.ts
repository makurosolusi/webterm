// State kartu Telegram: hubungkan token (write-only), nyala/mati bot, tautan pairing sekali pakai,
// daftar chat menunggu/tertaut, tautkan manual satu ketukan.
import { useCallback, useEffect, useRef, useState } from 'react'
import { bindChat, fetchBindings, fetchPending, ignorePending, unbindChat } from './channelsApi'
import type { PendingChat, TelegramBinding } from './channelsApi'
import { InboxApiError } from './inboxTypes'
import { fetchTelegramView, fetchTokenStored, postConnect, postEnabled, postPairing, type PairingLink } from './telegramCardApi'
import { TG, connectErrorText } from './telegramCardLabels'

/** Jeda penyegaran daftar chat menunggu saat tab terlihat. */
export const PENDING_POLL_MS = 5000
/** Minta kode baru sebelum yang lama kedaluwarsa (server: 10 menit). */
const PAIR_RENEW_MARGIN_MS = 60_000

/** Chat grup berid negatif -> viewer; privat -> owner (KE-10). */
export const roleFor = (chatId: string): 'viewer' | 'owner' => (chatId.startsWith('-') ? 'viewer' : 'owner')

export function useTelegramCard(projectId: string) {
  const [token, setToken] = useState('')
  const [connected, setConnected] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const [tokenStored, setTokenStored] = useState(false)
  const [bot, setBot] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingChat[]>([])
  const [bindings, setBindings] = useState<TelegramBinding[]>([])
  const [pair, setPair] = useState<PairingLink | null>(null)
  const pairRef = useRef<{ link: PairingLink; bound: number } | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  /** Kode dipakai (jumlah tautan bertambah), kedaluwarsa, atau proyek berganti -> minta baru. */
  const syncPair = useCallback(async (bound: number) => {
    const cur = pairRef.current
    const stale = !cur || cur.link.projectId !== projectId || bound > cur.bound
      || cur.link.expiresAt - PAIR_RENEW_MARGIN_MS <= Date.now()
    if (projectId === '' || !stale) return
    try {
      const link = await postPairing(projectId)
      pairRef.current = { link, bound }
      if (alive.current) setPair(link)
    } catch {
      // Tautan gagal dibuat (Telegram tak terjangkau): jalur Tautkan manual tetap ada; dicoba lagi tiap poll.
      pairRef.current = null
      if (alive.current) setPair(null)
    }
  }, [projectId])

  const refresh = useCallback(async () => {
    try {
      const view = await fetchTelegramView()
      if (!alive.current) return
      const on = view.status === 'on'
      setConnected(on)
      setDetail(on ? view.detail ?? null : null)
      if (!on) {
        setPending([]); setBindings([]); setBot(null); setPair(null); pairRef.current = null
        const stored = await fetchTokenStored().catch(() => false)
        if (alive.current) setTokenStored(stored)
        return
      }
      const [p, b] = await Promise.all([fetchPending(), fetchBindings()])
      if (!alive.current) return
      setPending(p)
      setBindings(b)
      await syncPair(b.length)
    } catch {
      // Segarkan latar gagal (jaringan putus): tampilan terakhir dipertahankan, percobaan berikutnya jalan sendiri.
    }
  }, [syncPair])

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

  const act = useCallback(async (fn: () => Promise<void>, failText: string = TG.errAction) => {
    setError(null)
    try {
      await fn()
    } catch {
      if (alive.current) setError(failText)
    }
    await refresh()
  }, [refresh])

  // Nama bot: detail server ("Tersambung sebagai @x"), lalu hasil connect, lalu tautan pairing.
  const botName = bot ?? pair?.bot ?? null
  const status = detail ?? (botName ? TG.connected(botName) : TG.connectedAnon)

  return {
    token, setToken, connected, status, tokenStored, connecting, error, pending, bindings, connect, pair,
    projectName: pair?.projectName ?? null,
    stopBot: () => act(async () => { await postEnabled(false); setBot(null) }),
    restart: () => act(async () => {
      // Token tersimpan tak terbaca -> server memberi needs-step (form token tampil): beri tahu sebabnya.
      if ((await postEnabled(true)) !== 'on' && alive.current) setError(TG.errRestart)
    }, TG.errRestart),
    link: (c: PendingChat) => act(() => bindChat({ projectId, chatId: c.chatId, role: roleFor(c.chatId) })),
    ignore: (c: PendingChat) => act(() => ignorePending(c.chatId)),
    unbind: (b: TelegramBinding) => act(() => unbindChat(b.chatId)),
  }
}
