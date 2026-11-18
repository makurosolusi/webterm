// Split shortcuts of one browser node: Ctrl/Cmd+\ splits right, Ctrl/Cmd+Alt+Arrow moves the focus to the neighbouring
// pane (Ctrl/Cmd+W, in useBrowserTabShortcuts, closes the focused pane's tab). Same rules as the tab shortcuts: only while
// focus is inside the node, never in a terminal or a text field of its own, handled in the capture phase.
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { isMacPlatform } from '@/terminalKeys'
import type { Direction } from '../../shared/browser.layout'
import { belongsToOtherEditor } from '../browserTabs/useBrowserTabShortcuts'

export type SplitShortcut = { kind: 'splitRight' } | { kind: 'focus'; dir: Direction }

type KeyLike = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/** The split shortcut a keydown asks for, or null when the key belongs to the page. */
export function splitShortcut(e: KeyLike, isMac: boolean): SplitShortcut | null {
  if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.shiftKey) return null
  if (e.code === 'Backslash' && !e.altKey) return { kind: 'splitRight' }
  const dir = ARROWS[e.code]
  return e.altKey && dir ? { kind: 'focus', dir } : null
}

export interface SplitShortcutsOptions {
  containerRef: RefObject<HTMLElement | null>
  onSplitRight: () => void
  onFocus: (dir: Direction) => void
  enabled?: boolean
}

export function useBrowserSplitShortcuts(opts: SplitShortcutsOptions): void {
  const latest = useRef(opts)
  latest.current = opts
  const { containerRef, enabled = true } = opts
  useEffect(() => {
    const el = containerRef.current
    if (!el || !enabled) return
    const onKey = (e: KeyboardEvent) => {
      const s = splitShortcut(e, isMacPlatform())
      if (!s || e.isComposing || belongsToOtherEditor(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (s.kind === 'splitRight') latest.current.onSplitRight()
      else latest.current.onFocus(s.dir)
    }
    el.addEventListener('keydown', onKey, true)
    return () => el.removeEventListener('keydown', onKey, true)
  }, [containerRef, enabled])
}
