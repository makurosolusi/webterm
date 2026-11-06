import { createElement, useCallback, useEffect, useMemo } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useInboxBadge, useInboxHotkey } from './inboxDockState'
import { outputPaletteCommands, useOutputToggleHotkey } from './output/outputCommands'
import { useOutputStatusItems } from './output/outputStatusItem'
import { resolveTerminalTheme } from './themes'
import { toggleTimeline } from './Timeline'
import type { VscodeStatusItem } from '@/components/vscode/vscodeStatusBar'
import { subscribeStatus } from './ws'
import { validateToken, storeToken, clearToken } from './api'
import type { Settings } from '../shared/settings'
import type { AgentStatus } from '../shared/workspace'

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

// Satu-satunya penulis `data-theme`; `styles.css` menyimpan varian terangnya di
// `:root[data-theme='light']`. 'auto' mengikut tema terminal supaya memilih skema terang
// tidak menyisakan rangka hitam di sekelilingnya.
/** Menulis `data-theme` di <html> mengikuti pengaturan tema aplikasi. */
export function useAppTheme(settings: Pick<Settings, 'appTheme' | 'terminalTheme'>) {
  useEffect(() => {
    const dark = settings.appTheme === 'auto'
      ? resolveTerminalTheme(settings.terminalTheme).dark
      : settings.appTheme === 'dark'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [settings.appTheme, settings.terminalTheme])
}

/** Login (simpan token lalu reload) dan logout (hapus token lalu reload). */
export function useAuthActions() {
  // Token disimpan lalu halaman di-reload: `api.ts` menangkap token sekali saat import, jadi hanya
  // load berikutnya yang membacanya kembali — reload adalah cara termalas yang benar, bukan membuat
  // modul token bisa dimutasi hidup-hidup.
  const onLogin = useCallback(async (t: string) => {
    if (await validateToken(t)) { storeToken(t); location.reload(); return true }
    return false
  }, [])
  const onLogout = useCallback(() => { clearToken(); location.reload() }, [])
  return { onLogin, onLogout }
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

/** Badge + hotkey Inbox dan item status/palette panel Output untuk Dock. */
export function useDockFeeds(inboxOpen: boolean, setInboxOpen: (open: boolean) => void, inboxReady: boolean) {
  // Inbox + badge berbagi satu endpoint (`GET /api/inbox`), jadi hanya SATU yang memuat pada satu
  // waktu: panel saat terbuka (pollMs di bawah), hook badge saat tertutup. Sebelum hidrasi dan di
  // layar Welcome keduanya diam. Tombol `i` hanya hidup ketika memang ada board.
  const inboxUnread = useInboxBadge({ panelOpen: inboxOpen, enabled: inboxReady })
  useInboxHotkey(() => setInboxOpen(!inboxOpen), inboxReady)
  // Panel Output (log sistem): state-nya modul bersama, jadi menu View, palette, dan status bar
  // tak perlu prop. Lihat `./output/outputCommands`.
  useOutputToggleHotkey()
  const outputItems = useOutputStatusItems()
  const outputStatusItems = useMemo(() => [...outputItems, ACTIVITY_STATUS_ITEM], [outputItems])
  const outputCommands = useMemo(() => outputPaletteCommands(), [])
  return { inboxUnread, outputStatusItems, outputCommands }
}
