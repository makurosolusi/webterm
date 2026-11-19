// Page-side scripts of the canvas browser's context menu (see docs/decisions/canvas-containment.md "Browser node context menu").
// Neither script uses a CDP binding: `bindingCalled` is only delivered with Runtime enabled, which the host keeps off
// (anti-bot detectable). The host reads results through `Runtime.evaluate` return values instead.

/**
 * Installed with `Page.addScriptToEvaluateOnNewDocument` on every page we create (runs in every same-process frame).
 * Bubble phase on window: a site that handled the event itself (custom menu, own middle click) has already called
 * preventDefault and wins; otherwise the default is cancelled, so Chromium never opens its native menu or a new tab/window
 * from a middle or Ctrl/Cmd+click on a link. The matching webterm action is done by the host (browserHost.contextMenu.ts).
 * Catches the paths the host does not see as a mouse press: the keyboard menu key / Shift+F10, long press.
 */
export const BACKSTOP_SCRIPT = `(() => {
  try {
    if (window.__webtermCtx) return
    Object.defineProperty(window, '__webtermCtx', { value: true })
    const cancel = (e) => { if (!e.defaultPrevented) e.preventDefault() }
    const onLink = (e) => !!(e.target && e.target.closest && e.target.closest('a[href]'))
    addEventListener('contextmenu', cancel, false)
    addEventListener('auxclick', (e) => { if (e.button === 1 && onLink(e)) cancel(e) }, false)
    addEventListener('click', (e) => { if ((e.ctrlKey || e.metaKey) && onLink(e)) cancel(e) }, false)
  } catch (e) {
    return // a page that breaks the script must not break the page
  }
})()`

/**
 * Hit-test at (x, y) in CSS px of the page viewport (same-origin iframes are entered). With `fire`, a synthetic
 * `contextmenu` is dispatched first: when the site cancels it (its own menu, Figma/Docs) the result is `{custom:true}`.
 * Returns JSON text; the host treats it as untrusted (`sanitizeContext`).
 */
export function hitExpression(x: number, y: number, fire: boolean): string {
  return `((x, y, fire) => {
  try {
    let doc = document, ox = x, oy = y, el = doc.elementFromPoint(ox, oy)
    for (let i = 0; i < 4 && el && el.tagName === 'IFRAME'; i++) {
      let d = null
      try { d = el.contentDocument } catch (e) { d = null }
      if (!d) break
      const r = el.getBoundingClientRect()
      ox -= r.left + el.clientLeft; oy -= r.top + el.clientTop
      const inner = d.elementFromPoint(ox, oy)
      if (!inner) break
      el = inner; doc = d
    }
    if (!el) return '{}'
    if (fire && !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: ox, clientY: oy, button: 2, view: doc.defaultView }))) return '{"custom":true}'
    const a = el.closest('a[href]'), img = el.closest('img'), ed = el.closest('input,textarea,[contenteditable]')
    const editable = !!ed && (ed.isContentEditable || (/^(INPUT|TEXTAREA)$/.test(ed.tagName) && !ed.readOnly && !ed.disabled && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/.test(ed.type)))
    return JSON.stringify({ link: a ? { href: a.href, text: (a.textContent || '').slice(0, 300) } : undefined, image: img ? (img.currentSrc || img.src) : undefined, selection: String(doc.getSelection()).length > 0, editable })
  } catch (e) {
    return '{}'
  }
})(${Number(x)}, ${Number(y)}, ${fire ? 'true' : 'false'})`
}
