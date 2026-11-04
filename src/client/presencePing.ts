// Detak kehadiran tab untuk penerusan desktop -> Telegram (server: channelPresence). Dipasang sekali
// di App, bukan di kartu Telegram: kehadiran milik tab, bukan milik panel yang kebetulan terbuka.
import { useEffect } from 'react'
import { postPresence } from './telegramCardApi'
import { readNotifyPrefs } from './osNotify.prefs'
import { InboxApiError } from './inboxTypes'

/** Interval detak selama tab terlihat; jauh di bawah ambang "away" server (menit). */
export const PRESENCE_PING_MS = 30_000

function ping(): void {
  postPresence(document.visibilityState === 'visible', readNotifyPrefs().muted).catch((err: unknown) => {
    // 404 = Telegram mati (rute tak terpasang): kondisi normal, bukan galat.
    if (err instanceof InboxApiError && err.status === 404) return
    console.warn('[presence] POST /api/channels/presence failed', err)
  })
}

/** Kirim detak kehadiran tiap 30 dtk selama tab terlihat dan saat tab kembali terlihat. */
export function usePresencePing(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onVisibility = (): void => { if (document.visibilityState === 'visible') ping() }
    onVisibility()
    const timer = setInterval(onVisibility, PRESENCE_PING_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
}
