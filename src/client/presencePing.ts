// Detak kehadiran tab untuk penerusan desktop -> Telegram (server: channelPresence). Dipasang sekali
// di App, bukan di kartu Telegram: kehadiran milik tab, bukan milik panel yang kebetulan terbuka.
import { useEffect } from 'react'
// Detak juga membawa node yang sedang ditempati (F3-a, attention per node): inbox server tidak
// mem-push kartu Telegram untuk node yang sedang dilihat (Orca suppress-while-focused).
import { readNotifyPrefs } from './osNotify.prefs'
import { InboxApiError } from './inboxTypes'
import { request } from './inboxTransport'
import { closestNodeRoot } from './nodeRoot'
import { getTabLayout } from './tabLayout.store'
import { onUserActive, userIdleMs } from './userActivity'
import { getConnection, streamPaused, subscribeConnection } from './ws.connection'

/** Interval detak selama tab terlihat; jauh di bawah ambang "away" server (menit). */
export const PRESENCE_PING_MS = 30_000
/** Detak tambahan saat fokus pindah node, paling sering sekali per jeda ini. */
export const FOCUS_PING_GAP_MS = 2000

/**
 * Node canvas yang ditempati: node yang memegang fokus keyboard, else node terpilih (sinyal yang
 * sama dengan `unread.watchNode`). Jendela tak fokus = tidak menonton apa pun.
 */
export function focusedNodeId(): string | null {
  if (!document.hasFocus()) return null
  const focused = closestNodeRoot(document.activeElement)?.dataset.id
  if (focused) return focused
  // Tab mode: the visible tab is what the user is looking at; canvas selection is hidden.
  const { mode, tabs } = getTabLayout()
  if (mode === 'tabs') return tabs.active
  return document.querySelector('.react-flow__node.selected')?.getAttribute('data-id') ?? null
}

// Satu peringatan per gangguan, bukan satu per detak: direset oleh detak yang berhasil.
let warned = false

function ping(): void {
  // Server tak terjangkau (socket bersama reconnecting/offline/auth): detak pasti gagal, lewati saja.
  // Bukan `!== 'connected'`: selama percobaan pertama (`connecting`) detak tetap jalan, server bisa saja sudah hidup.
  if (streamPaused()) return
  const visible = document.visibilityState === 'visible'
  const idle = userIdleMs() // Central's camera tools refuse while the human drives the canvas
  const body = { visible, muted: readNotifyPrefs().muted, nodeId: visible ? focusedNodeId() : null, ...(Number.isFinite(idle) ? { idleMs: Math.round(idle) } : {}) }
  request<unknown>('/api/channels/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(() => { warned = false }, (err: unknown) => {
    // 404 = Telegram mati (rute tak terpasang): kondisi normal, bukan galat.
    if (err instanceof InboxApiError && err.status === 404) return
    if (warned) return
    warned = true
    console.warn('[presence] POST /api/channels/presence failed; silent until a ping succeeds', err)
  })
}

/** Kirim detak kehadiran tiap 30 dtk selama tab terlihat dan saat tab kembali terlihat. */
export function usePresencePing(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onVisibility = (): void => { if (document.visibilityState === 'visible') ping() }
    let lastFocusPing = 0
    const onFocus = (): void => {
      if (Date.now() - lastFocusPing < FOCUS_PING_GAP_MS) return
      lastFocusPing = Date.now()
      onVisibility()
    }
    // A gesture pings at once (throttled): the server's "is the human driving?" answer must not be 30 s stale.
    let lastActivePing = 0
    const offActive = onUserActive(() => {
      if (Date.now() - lastActivePing < FOCUS_PING_GAP_MS) return
      lastActivePing = Date.now()
      onVisibility()
    })
    onVisibility()
    const timer = setInterval(onVisibility, PRESENCE_PING_MS)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('focusin', onFocus)
    // Detak segera saat server kembali, bukan menunggu interval berikutnya.
    let phase = getConnection().phase
    const offConnection = subscribeConnection((c) => {
      const was = phase
      phase = c.phase
      if (c.phase === 'connected' && was !== 'connected') onVisibility()
    })
    return () => {
      offActive()
      offConnection()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('focusin', onFocus)
    }
  }, [enabled])
}
