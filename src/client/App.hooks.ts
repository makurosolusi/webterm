import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useNeedsYouCount } from './chat/needsYouApi'
import { outputPaletteCommands } from './output/outputCommands'
import { useOutputStatusItems } from './output/outputStatusItem'
import { toggleTimeline } from './Timeline'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { connectEagerly, subscribeStatus } from './ws'
import { useCommandKeybindings } from './commandRegistry'
import { useKeybindingsSync } from './keybindings.store'
import { usePresencePing } from './presencePing'
import { fetchSignedIn, isAbortError, logout } from './transportToken'
import type { Settings } from '../shared/settings'
import type { AgentStatus } from '../shared/workspace'
import type { StatusReason } from '../shared/protocol'

/** Signed-in session plumbing: keybindings sync + chords, presence ping, and the eager shared socket. */
export function useAppSession(signedIn: boolean, settings: Pick<Settings, 'keybindings'>, hydrated: boolean, update: (patch: Partial<Settings>) => void) {
  useKeybindingsSync(settings.keybindings, hydrated, update)
  useCommandKeybindings()
  usePresencePing(signedIn)
  useEffect(() => { if (signedIn) connectEagerly() }, [signedIn]) // App mounts only signed in (appBoot.tsx)
}

/** Mengalirkan status agent dari WebSocket ke state `statuses`. */
export function useStatusSubscription(setStatuses: Dispatch<SetStateAction<Record<string, AgentStatus>>>) {
  useEffect(() => {
    // `s` undefined = sapuan basi mencabut statusnya (`shared/agentStale.ts`), jadi key-nya DIHAPUS:
    // menaruh `undefined` di bawah key yang masih ada akan membuat node terbaca berstatus kosong.
    const unsub = subscribeStatus((id, s) =>
      setStatuses((prev) => {
        const next = { ...prev }
        if (s) next[id] = s
        else delete next[id]
        return next
      })
    )
    return unsub
  }, [setStatuses])
}

/** Why each node's current status needs you or failed (permission tool, question, error), live from
 *  the status channel; a node without a reason has no key. Feed it to `sessionStatusView`. */
export function useStatusReasons(): Record<string, StatusReason> {
  const [reasons, setReasons] = useState<Record<string, StatusReason>>({})
  useEffect(() => subscribeStatus((id, _s, reason) =>
    setReasons((prev) => {
      if (!reason && !(id in prev)) return prev
      const next = { ...prev }
      if (reason) next[id] = reason
      else delete next[id]
      return next
    })
  ), [])
  return reasons
}

// Satu-satunya penulis `data-theme`; `styles.css` menyimpan varian terangnya di
// `:root[data-theme='light']`. 'auto' (label "System") mengikuti mode OS lewat `prefers-color-scheme`
// dan ikut berubah saat OS berganti. Pilihan sadar (bukan auto = ikut tema terminal): kajian
// settings overhaul meminta Light/Dark/System seperti app desktop lain.
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Dark or light for an app theme setting; `osDark` = the OS prefers dark. */
export function resolveAppTheme(pref: Settings['appTheme'], osDark: boolean): 'dark' | 'light' {
  return pref === 'auto' ? (osDark ? 'dark' : 'light') : pref === 'light' ? 'light' : 'dark'
}

/** Menulis `data-theme` di <html> mengikuti pengaturan tema aplikasi. */
export function useAppTheme(settings: Pick<Settings, 'appTheme'>) {
  useEffect(() => {
    const mq = window.matchMedia?.(DARK_QUERY)
    const apply = (): void => { document.documentElement.dataset.theme = resolveAppTheme(settings.appTheme, mq?.matches ?? true) }
    apply()
    if (settings.appTheme !== 'auto' || !mq) return undefined
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.appTheme])
}

/** Whether this browser holds a UI session (drives the Logout entry), and sign-out. */
export function useAuthActions() {
  // false until GET /auth/session confirms this browser's cookie; Logout hides meanwhile.
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    const ac = new AbortController()
    fetchSignedIn(ac.signal).then(setSignedIn, (error: unknown) => {
      if (!isAbortError(error)) console.warn('[webterm] checking the UI session failed', error)
    })
    return () => ac.abort()
  }, [])
  // Reload either way: after a sign-out the boot fetch is refused and App shows SignInScreen; after
  // a failed one the page shows the still-signed-in board, which is the truth.
  const onLogout = useCallback(() => {
    logout().catch((error: unknown) => console.warn('[webterm] sign out failed', error)).finally(() => location.reload())
  }, [])
  return { signedIn, onLogout }
}

/** Kalimat ringkas jumlah agent working/blocked untuk status bar. */
export function useAgentSummary(statuses: Record<string, AgentStatus>) {
  // Satu kalimat yang dibaca pembaca layar lewat live region `VscodeStatusBar`. Angkanya
  // diturunkan dari status yang sudah ada, bukan state baru.
  return useMemo(() => {
    const values = Object.values(statuses)
    const working = values.filter((s) => s === 'working').length
    const blocked = values.filter((s) => s === 'blocked').length
    return [working ? `${working} working` : '', blocked ? `${blocked} need attention` : '']
      .filter(Boolean)
      .join(' · ')
  }, [statuses])
}

/** Status bar item that toggles the Activity timeline (same store as "View: Toggle Activity"). */
export const ACTIVITY_STATUS_ITEM: VscodeStatusItem = {
  id: 'activity', label: 'Activity', icon: createElement('span', { className: 'codicon codicon-pulse', 'aria-hidden': true }),
  tooltip: 'Toggle Activity timeline', ariaLabel: 'Toggle Activity timeline', onClick: toggleTimeline,
}

/** Badge Needs-you ikon Chat dan item status/palette panel Output untuk Dock. */
export function useDockFeeds() {
  // Badge berbagi SATU poller dengan strip Needs-you dan kartu persetujuan (`chat/needsYouApi`).
  const needsYouCount = useNeedsYouCount()
  // Panel Output (log sistem): state-nya modul bersama, jadi menu View, palette, dan status bar
  // tak perlu prop; chord Toggle Output ada di registry. Lihat `./output/outputCommands`.
  const outputItems = useOutputStatusItems()
  const outputStatusItems = useMemo(() => [...outputItems, ACTIVITY_STATUS_ITEM], [outputItems])
  const outputCommands = useMemo(() => outputPaletteCommands(), [])
  return { needsYouCount, outputStatusItems, outputCommands }
}
