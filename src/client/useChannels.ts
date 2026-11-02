// State + polling untuk section Channels. Polling ringan: tiap POLL_MS selagi tab terlihat, plus
// satu refresh saat window kembali fokus; semua listener/timer/request dibersihkan saat unmount.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  channelsErrorMessage,
  fetchBindings,
  fetchPending,
  fetchStatus,
  isAbortError,
  type PendingChat,
  type TelegramBinding,
  type TelegramStatus,
} from './channelsApi'

export const CHANNELS_POLL_MS = 5000

export interface ChannelsState {
  loading: boolean
  /** true = server menjawab 404 untuk status. */
  inactive: boolean
  status: TelegramStatus | null
  pending: PendingChat[]
  bindings: TelegramBinding[]
  /** Error baca (polling); data lama tetap ditampilkan. */
  error: string | null
  /** Error aksi terakhir (bind/abaikan/hapus). */
  actionError: string | null
  busy: boolean
  refresh: () => void
  /** Jalankan aksi mutasi lalu segarkan; true bila sukses. */
  act: (fn: () => Promise<void>) => Promise<boolean>
}

/** Hook data channel Telegram; hanya pasang saat section terlihat. */
export function useChannels(): ChannelsState {
  const [loading, setLoading] = useState(true)
  const [inactive, setInactive] = useState(false)
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [pending, setPending] = useState<PendingChat[]>([])
  const [bindings, setBindings] = useState<TelegramBinding[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ctl = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const inflight = useRef(false)
  // Nomor muatan terbaru: hasil muatan yang sudah tersusul (mis. dimulai sebelum aksi mutasi) dibuang.
  const seq = useRef(0)

  const load = useCallback(async (force = false): Promise<void> => {
    if (!alive.current || (inflight.current && !force)) return
    const mine = ++seq.current
    inflight.current = true
    const signal = ctl.current?.signal
    try {
      const st = await fetchStatus(signal)
      if (!alive.current || mine !== seq.current) return
      if (st === null) {
        setInactive(true)
        setStatus(null)
        setError(null)
        return
      }
      const [p, b] = await Promise.all([fetchPending(signal), fetchBindings(signal)])
      if (!alive.current || mine !== seq.current) return
      setInactive(false)
      setStatus(st)
      setPending(p)
      setBindings(b)
      setError(null)
    } catch (e) {
      if (!isAbortError(e) && alive.current && mine === seq.current) setError(channelsErrorMessage(e))
    } finally {
      if (mine === seq.current) {
        inflight.current = false
        if (alive.current) setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    alive.current = true
    ctl.current = new AbortController()
    void load()
    const tick = (): void => {
      if (document.visibilityState !== 'hidden') void load()
    }
    const timer = setInterval(tick, CHANNELS_POLL_MS)
    window.addEventListener('focus', tick)
    return () => {
      alive.current = false
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      ctl.current?.abort()
    }
  }, [load])

  const act = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      setBusy(true)
      setActionError(null)
      try {
        await fn()
      } catch (e) {
        if (alive.current) setActionError(channelsErrorMessage(e))
        return false
      } finally {
        if (alive.current) setBusy(false)
      }
      await load(true)
      return true
    },
    [load],
  )

  const refresh = useCallback(() => void load(true), [load])

  return { loading, inactive, status, pending, bindings, error, actionError, busy, refresh, act }
}
