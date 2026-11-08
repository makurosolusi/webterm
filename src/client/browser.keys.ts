// Browser-level shortcuts for the Browser node. Chromium ignores these when they arrive over CDP
// (they belong to the browser UI, not the page), so the node handles them itself and never forwards
// them. Zoom matching is ported from nodeterm `shared/webview-zoom.ts` `webviewZoomShortcut`.

export type BrowserChord =
  | 'focusUrl' | 'reload' | 'hardReload' | 'back' | 'forward' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'stop'

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** The browser action a keydown asks for, or null when the key belongs to the page. */
export function browserChord(e: KeyLike, isMac: boolean): BrowserChord | null {
  const anyMod = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
  if (e.key === 'Escape' && !anyMod) return 'stop'
  // Windows/Linux back/forward (Chrome): Alt+Left / Alt+Right, nothing else held.
  if (!isMac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (e.code === 'ArrowLeft') return 'back'
    if (e.code === 'ArrowRight') return 'forward'
  }
  if (e.altKey) return null
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) return null
  // Equal is the physical +/- key on common layouts, so Shift is valid only for zooming in.
  if (e.code === 'Equal' || (!e.shiftKey && e.code === 'NumpadAdd')) return 'zoomIn'
  if (e.code === 'KeyR') return e.shiftKey ? 'hardReload' : 'reload'
  if (e.shiftKey) return null
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') return 'zoomOut'
  if (e.code === 'Digit0' || e.code === 'Numpad0') return 'zoomReset'
  if (e.code === 'KeyL') return 'focusUrl'
  // ⌘[ / ⌘] are macOS-only in Chrome; Ctrl+[ elsewhere is Escape for terminals and editors in the page.
  if (isMac && e.code === 'BracketLeft') return 'back'
  if (isMac && e.code === 'BracketRight') return 'forward'
  return null
}
