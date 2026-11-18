// Keys on a focused tab (WAI-ARIA tabs, manual activation like VS Code): arrows/Home/End move focus,
// Enter/Space activate, Delete or Ctrl/Cmd+W close, Alt+Shift+arrows reorder, Menu key / Shift+F10 opens the menu.

export type TabKeyIntent =
  | { kind: 'focus'; to: 'prev' | 'next' | 'first' | 'last' }
  | { kind: 'move'; dir: -1 | 1 }
  | { kind: 'activate' }
  | { kind: 'close' }
  | { kind: 'menu' }

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

export function tabKeyIntent(e: KeyLike, isMac: boolean): TabKeyIntent | null {
  const arrow = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
  if (arrow && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) return { kind: 'move', dir: arrow }
  const anyMod = e.altKey || e.ctrlKey || e.metaKey
  if (e.key === 'w' || e.key === 'W') return (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey ? { kind: 'close' } : null
  if (e.key === 'F10' && e.shiftKey && !anyMod) return { kind: 'menu' }
  if (anyMod || e.shiftKey) return null
  switch (e.key) {
    case 'ArrowLeft': return { kind: 'focus', to: 'prev' }
    case 'ArrowRight': return { kind: 'focus', to: 'next' }
    case 'Home': return { kind: 'focus', to: 'first' }
    case 'End': return { kind: 'focus', to: 'last' }
    case 'Enter': case ' ': return { kind: 'activate' }
    case 'Delete': return { kind: 'close' }
    case 'ContextMenu': return { kind: 'menu' }
    default: return null
  }
}

/** Index to focus for a `focus` intent, wrapping at both ends. */
export function focusTarget(to: 'prev' | 'next' | 'first' | 'last', from: number, count: number): number {
  if (to === 'first') return 0
  if (to === 'last') return count - 1
  return (from + (to === 'next' ? 1 : -1) + count) % count
}
