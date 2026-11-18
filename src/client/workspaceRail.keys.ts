// Keys on a focused workspace tile (WAI-ARIA tabs, vertical, manual activation like the strip): Up/Down
// move focus, Home/End jump, Enter/Space activate, F2 renames, Menu key / Shift+F10 opens the menu,
// Alt+Shift+Up/Down reorder (the keyboard alternative to dragging, WCAG 2.5.7).
export type TileKeyIntent =
  | { kind: 'focus'; to: 'prev' | 'next' | 'first' | 'last' }
  | { kind: 'move'; dir: -1 | 1 }
  | { kind: 'activate' }
  | { kind: 'rename' }
  | { kind: 'menu' }

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

export function tileKeyIntent(e: KeyLike): TileKeyIntent | null {
  const arrow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
  if (arrow && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) return { kind: 'move', dir: arrow }
  if (e.key === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) return { kind: 'menu' }
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null
  switch (e.key) {
    case 'ArrowUp': return { kind: 'focus', to: 'prev' }
    case 'ArrowDown': return { kind: 'focus', to: 'next' }
    case 'Home': return { kind: 'focus', to: 'first' }
    case 'End': return { kind: 'focus', to: 'last' }
    case 'Enter': case ' ': return { kind: 'activate' }
    case 'F2': return { kind: 'rename' }
    case 'ContextMenu': return { kind: 'menu' }
    default: return null
  }
}

/** Index to focus for a `focus` intent, wrapping at both ends. */
export function focusIndex(to: 'prev' | 'next' | 'first' | 'last', from: number, count: number): number {
  if (to === 'first') return 0
  if (to === 'last') return count - 1
  return (from + (to === 'next' ? 1 : -1) + count) % count
}
