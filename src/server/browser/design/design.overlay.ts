// Design Mode overlay: the script injected into the browser node's page while Design Mode is on.
// Imitated: Cursor's browser "select element" and v0/Lovable visual edit (hover highlight, click to
// pick, several picks, then a comment), react-grab (element HTML + component name + "at file:line:col"),
// LocatorJS / React DevTools (source from the React fiber `_debugSource`, or a build-time data
// attribute such as `data-inspector-*` / `data-v-inspector` / `data-source`).
//
// `installDesignOverlay` is SELF-CONTAINED (no imports, no outer references): it is serialized with
// `Function.prototype.toString` into `DESIGN_OVERLAY_SOURCE`, and tests call it directly in jsdom.
// Nothing it reads is trusted: the server wraps everything it returns as untrusted web content.

/** One picked element as the overlay reports it (CSS px, relative to the viewport). */
export interface DesignPick {
  selector: string
  tag: string
  html: string
  styles: Record<string, string>
  box: { x: number; y: number; width: number; height: number }
  source?: string
  component?: string
}

/** What `collect()` returns: the picks plus the page geometry the crop needs. */
export interface DesignCollect {
  url: string
  title: string
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  picks: DesignPick[]
}

/** The page-global the overlay installs (and removes). */
export const DESIGN_GLOBAL = '__webtermDesign'

/** Install the picker on `win` (idempotent). Returns the controller also stored at `win.__webtermDesign`. */
export function installDesignOverlay(win: Window & typeof globalThis): unknown {
  const KEY = '__webtermDesign'
  const w = win as unknown as Record<string, unknown>
  if (w[KEY]) return w[KEY]
  const doc = win.document
  const HTML_MAX = 1500
  const STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
    'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'gap', 'flex-direction',
    'justify-content', 'align-items', 'box-shadow', 'opacity', 'z-index']
  const MARK = 'data-webterm-design'
  const picked: Element[] = []
  let root: HTMLElement | null = null
  let hover: HTMLElement | null = null
  let badge: HTMLElement | null = null
  let boxes: HTMLElement[] = []

  const esc = (s: string) => (win.CSS && win.CSS.escape ? win.CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`))
  const unique = (sel: string) => { try { return doc.querySelectorAll(sel).length === 1 } catch { return false } }
  // Ids that look generated (React useId ":r1:", long hex/digit runs) change between renders: not stable.
  const stableId = (id: string) => !!id && !/^:|\d{3,}|[a-f0-9]{8,}/i.test(id)

  /** Shortest stable unique selector: id, test attributes, aria/name, else a nth-of-type path to an anchor. */
  function selectorOf(el: Element): string {
    if (stableId(el.id) && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name']) {
      const v = el.getAttribute(a)
      const sel = `${el.tagName.toLowerCase()}[${a}="${v ? v.replace(/"/g, '\\"') : ''}"]`
      if (v && unique(sel)) return sel
    }
    const parts: string[] = []
    let cur: Element | null = el
    while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
      if (cur !== el && stableId(cur.id) && unique(`#${esc(cur.id)}`)) { parts.unshift(`#${esc(cur.id)}`); break }
      const tag = cur.tagName.toLowerCase()
      const parent: Element | null = cur.parentElement
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : []
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag)
      cur = parent
    }
    return parts.join(' > ')
  }

  /** Source location: build-time data attribute first, then the React fiber's `_debugSource` (dev builds). */
  function sourceOf(el: Element): { source?: string; component?: string } {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const file = cur.getAttribute('data-inspector-relative-path')
      if (file) return { source: `${file}:${cur.getAttribute('data-inspector-line') ?? '?'}:${cur.getAttribute('data-inspector-column') ?? '?'}` }
      const one = cur.getAttribute('data-v-inspector') ?? cur.getAttribute('data-source') ?? cur.getAttribute('data-locator')
      if (one) return { source: one }
    }
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'))
    type Fiber = { return?: Fiber | null; type?: unknown; _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } }
    let f: Fiber | null | undefined = k ? (el as unknown as Record<string, Fiber>)[k] : null
    let source: string | undefined
    let component: string | undefined
    for (let i = 0; f && i < 50; i++, f = f.return) {
      const s = f._debugSource
      if (!source && s && s.fileName) source = `${s.fileName}:${s.lineNumber ?? '?'}:${s.columnNumber ?? '?'}`
      const t = f.type as { displayName?: string; name?: string } | string | null | undefined
      if (!component && t && typeof t !== 'string') component = t.displayName || t.name || undefined
      if (source && component) break
    }
    return { ...(source ? { source } : {}), ...(component ? { component } : {}) }
  }

  function describe(el: Element) {
    const r = el.getBoundingClientRect()
    const cs = win.getComputedStyle(el)
    const styles: Record<string, string> = {}
    for (const p of STYLE_KEYS) { const v = cs.getPropertyValue(p); if (v) styles[p] = v }
    const html = el.outerHTML
    return {
      selector: selectorOf(el), tag: el.tagName.toLowerCase(),
      html: html.length > HTML_MAX ? `${html.slice(0, HTML_MAX)}…` : html,
      styles, box: { x: r.left, y: r.top, width: r.width, height: r.height }, ...sourceOf(el),
    }
  }

  const frame = (color: string) => {
    const d = doc.createElement('div')
    d.setAttribute(MARK, '')
    d.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid ${color};background:${color}22;display:none`
    root!.appendChild(d)
    return d
  }
  const place = (d: HTMLElement, el: Element) => {
    const r = el.getBoundingClientRect()
    Object.assign(d.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  }
  function redraw() {
    if (!root) return
    for (const b of boxes) b.remove()
    boxes = picked.map((el) => { const b = frame('#f97316'); place(b, el); return b })
    if (badge) { badge.textContent = `Design Mode: ${picked.length} selected (click to pick, Esc to clear)`; }
  }
  const ours = (t: EventTarget | null) => t instanceof win.Element && t.closest(`[${MARK}]`) !== null
  const target = (e: Event) => (e.target instanceof win.Element && !ours(e.target) ? e.target : null)

  const onMove = (e: Event) => { const el = target(e); if (el && hover) place(hover, el) }
  const block = (e: Event) => { if (target(e)) { e.preventDefault(); e.stopPropagation() } }
  const onClick = (e: Event) => {
    const el = target(e)
    if (!el) return
    e.preventDefault(); e.stopPropagation()
    const i = picked.indexOf(el)
    if (i >= 0) picked.splice(i, 1); else picked.push(el)
    redraw()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { picked.length = 0; redraw() } }
  const onScroll = () => redraw()
  const BLOCKED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu']

  function mount() {
    if (root || !doc.body) return
    root = doc.createElement('div')
    root.setAttribute(MARK, '')
    doc.documentElement.appendChild(root)
    hover = frame('#0a84ff')
    badge = doc.createElement('div')
    badge.setAttribute(MARK, '')
    badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;font:12px system-ui;color:#fff;background:#0a84ffdd;padding:4px 8px;border-radius:4px'
    root.appendChild(badge)
    redraw()
  }
  win.addEventListener('mousemove', onMove, true)
  win.addEventListener('click', onClick, true)
  for (const t of BLOCKED) win.addEventListener(t, block, true)
  win.addEventListener('keydown', onKey, true)
  win.addEventListener('scroll', onScroll, true)
  // Injected on a new document before <body> exists: mount once the DOM is there.
  if (doc.body) mount(); else doc.addEventListener('DOMContentLoaded', mount)

  const api = {
    collect() {
      return {
        url: String(win.location.href), title: doc.title,
        viewport: { width: win.innerWidth, height: win.innerHeight, scrollX: win.scrollX, scrollY: win.scrollY },
        picks: picked.filter((el) => el.isConnected).map(describe),
      }
    },
    /** Hide our frames for the screenshot; `show()` brings them back. */
    hide() { if (root) root.style.display = 'none' },
    show() { if (root) root.style.display = '' },
    remove() {
      win.removeEventListener('mousemove', onMove, true)
      win.removeEventListener('click', onClick, true)
      for (const t of BLOCKED) win.removeEventListener(t, block, true)
      win.removeEventListener('keydown', onKey, true)
      win.removeEventListener('scroll', onScroll, true)
      doc.removeEventListener('DOMContentLoaded', mount)
      root?.remove(); root = null
      picked.length = 0
      delete w[KEY]
    },
  }
  w[KEY] = api
  return api
}

/** The script text sent to the page (evaluated now and on every new document while Design Mode is on). */
export const DESIGN_OVERLAY_SOURCE = `(${installDesignOverlay.toString()})(window);`
