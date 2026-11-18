// Browser-style tab shortcuts for one browser node: Ctrl/Cmd+T, Ctrl/Cmd+W, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl/Cmd+1..8,
// Ctrl/Cmd+Shift+T. Listens on the node's container in the capture phase (like BrowserNode's chords: Chromium never
// sees these over CDP), so it only fires while focus is inside the node, and leaves terminals and text editors alone.
import { useEffect, useRef, type RefObject } from 'react'
import { isMacPlatform } from '@/terminalKeys'
import { MAX_TABS_PER_NODE, canAddTab, newTabId, type BrowserTabAction, type BrowserTabsState } from '../../shared/browser.tabs'

export type TabShortcut =
  | { kind: 'new' } | { kind: 'close' } | { kind: 'reopen' }
  | { kind: 'cycle'; dir: 1 | -1 } | { kind: 'index'; n: number }

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** The tab shortcut a keydown asks for, or null when the key belongs to the page. */
export function tabShortcut(e: KeyLike, isMac: boolean): TabShortcut | null {
  if (e.altKey) return null
  if (e.key === 'Tab' && e.ctrlKey && !e.metaKey) return { kind: 'cycle', dir: e.shiftKey ? -1 : 1 }
  if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return null
  if (e.code === 'KeyT') return e.shiftKey ? { kind: 'reopen' } : { kind: 'new' }
  if (e.shiftKey) return null
  if (e.code === 'KeyW') return { kind: 'close' }
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
  return digit && Number(digit) <= MAX_TABS_PER_NODE ? { kind: 'index', n: Number(digit) } : null
}

/** Focus is in a terminal or a text editor that is not the browser's own address field. */
export function belongsToOtherEditor(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return true
  if (target.closest('[data-browser-omnibox], [data-tab-shortcuts]')) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

export interface TabShortcutsOptions {
  containerRef: RefObject<HTMLElement | null>
  state: BrowserTabsState
  onAction: (a: BrowserTabAction) => void
  /** Reason a shortcut could not run (tab limit, nothing to reopen). */
  onNotice?: (text: string) => void
  makeId?: () => string
  enabled?: boolean
}

export function useBrowserTabShortcuts(opts: TabShortcutsOptions): void {
  const latest = useRef(opts)
  latest.current = opts
  const { containerRef, enabled = true } = opts
  useEffect(() => {
    const el = containerRef.current
    if (!el || !enabled) return
    const onKey = (e: KeyboardEvent) => {
      const { state, onAction, onNotice, makeId = newTabId } = latest.current
      const s = tabShortcut(e, isMacPlatform())
      if (!s || e.isComposing || belongsToOtherEditor(e.target)) return
      // A focused tab handles its own Ctrl/Cmd+W (it closes that tab, not the active one).
      if (s.kind === 'close' && e.target instanceof HTMLElement && e.target.closest('[role="tab"]')) return
      const { tabs, activeTabId } = state
      const at = tabs.findIndex((t) => t.tabId === activeTabId)
      let target: BrowserTabAction | null = null
      if (s.kind === 'index') {
        const t = tabs[s.n - 1]
        if (!t) return // no such tab: the key is not ours
        target = { type: 'activate', tabId: t.tabId }
      } else if (s.kind === 'cycle') {
        if (tabs.length < 2) return
        target = { type: 'activate', tabId: tabs[(at + s.dir + tabs.length) % tabs.length].tabId }
      } else if (s.kind === 'close') {
        if (at < 0) return
        target = { type: 'close', tabId: tabs[at].tabId }
      } else {
        const add = canAddTab(state)
        if (!add.ok) onNotice?.(add.reason)
        else if (s.kind === 'reopen' && state.closed.length === 0) onNotice?.('No recently closed tabs')
        else target = s.kind === 'new' ? { type: 'new', newTabId: makeId() } : { type: 'reopenClosed', newTabId: makeId() }
      }
      e.preventDefault()
      e.stopPropagation()
      if (target) onAction(target)
    }
    el.addEventListener('keydown', onKey, true)
    return () => el.removeEventListener('keydown', onKey, true)
  }, [containerRef, enabled])
}
