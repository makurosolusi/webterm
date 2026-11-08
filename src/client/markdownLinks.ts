// Clicks on links inside RENDERED MARKDOWN must never navigate webterm's own tab.
//
// Port of nodeterm `src/renderer/lib/markdownLinks.ts` (decideMarkdownLinkClick + the click /
// middle-click guard). `renderMarkdown` keeps an anchor's href as written, and agents write relative
// links constantly (`[pty.ts](src/server/pty.ts:41)`). A plain click resolved it against the app URL
// and the whole canvas was gone; a middle click opened a stray 404 tab. Differences from nodeterm:
// webterm knows the folder of the file being previewed, so local links open the file in an editor
// node instead of a "can't open" toast; `#anchor` scrolls inside the preview; `mailto:`/`tel:` keep
// the browser's default (it hands them to the OS without leaving the page).

export type MarkdownLinkDecision =
  | { action: 'external'; url: string }
  | { action: 'local'; path: string; line?: number; column?: number }
  | { action: 'anchor'; id: string }
  | { action: 'native' }
  | { action: 'ignore' }

const WEB = new Set(['http:', 'https:'])
const NATIVE = new Set(['mailto:', 'tel:'])

const decode = (s: string): string => {
  try { return decodeURIComponent(s) } catch { return s }
}

/** `rel` against folder `dir`, `.`/`..` folded; absolute `rel` (leading `/`) wins. */
export function resolvePath(dir: string, rel: string): string {
  const parts = (rel.startsWith('/') ? rel : `${dir}/${rel}`).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return `/${out.join('/')}`
}

/**
 * What to do with a click on an anchor whose RAW `href` attribute is `rawHref`. Decided on the raw
 * attribute, never on the resolved `a.href`: resolution against the app document is exactly what
 * turns a harmless relative path into a navigation. `baseDir` = folder the markdown lives in; '' =
 * unknown (chat), where only absolute paths can be opened.
 */
export function decideMarkdownLinkClick(rawHref: string, baseDir = ''): MarkdownLinkDecision {
  const href = rawHref.trim()
  if (href === '') return { action: 'ignore' }
  if (href.startsWith('#')) return href.length > 1 ? { action: 'anchor', id: decode(href.slice(1)) } : { action: 'ignore' }
  let parsed: URL | null = null
  try {
    // No base: only an ABSOLUTE URL parses. Relative and protocol-relative hrefs throw → local.
    parsed = new URL(href)
  } catch { /* relative: handled below */ }
  if (parsed) {
    if (WEB.has(parsed.protocol)) return { action: 'external', url: parsed.href }
    if (NATIVE.has(parsed.protocol)) return { action: 'native' }
    if (parsed.protocol !== 'file:') return { action: 'ignore' }
  }
  const raw = parsed ? parsed.pathname : href.replace(/[?#].*$/, '')
  if (!raw || raw.startsWith('//')) return { action: 'ignore' }
  // `file.ts:12` / `file.ts:12:3`: the line form agents write.
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(decode(raw))
  const rel = m ? m[1]! : decode(raw)
  if (!rel.startsWith('/') && !baseDir) return { action: 'ignore' }
  const path = resolvePath(baseDir, rel)
  return m ? { action: 'local', path, line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined } : { action: 'local', path }
}

export interface MarkdownLinkDeps {
  openUrl(url: string): void
  openFile(path: string, line?: number, column?: number): void
  scrollToAnchor?(id: string): void
}

interface LinkEvent { target: EventTarget | null; button: number; defaultPrevented: boolean; preventDefault(): void }

/**
 * `onClick` + `onAuxClick` handler for a rendered-markdown container. Primary and middle button only
 * (a middle click never fires `click`; its `auxclick` default opens a new tab). Modifier clicks are
 * handled the same way: letting the default run would open the unresolvable relative URL anyway.
 */
export function handleMarkdownLinkEvent(e: LinkEvent, baseDir: string, deps: MarkdownLinkDeps): void {
  if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return
  const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null
  if (!anchor) return
  const d = decideMarkdownLinkClick(anchor.getAttribute('href') ?? '', baseDir)
  if (d.action === 'native') return
  e.preventDefault()
  if (d.action === 'external') deps.openUrl(d.url)
  else if (d.action === 'local') deps.openFile(d.path, d.line, d.column)
  else if (d.action === 'anchor') deps.scrollToAnchor?.(d.id)
}

type OpenBrowser = (req: { url: string; anchorNodeId?: string }) => { status: string }

/** Web link → a browser node on the canvas; a new browser tab when the browser node is off/refuses it. */
export function openWebLink(openBrowserAt: OpenBrowser | undefined, url: string, anchorNodeId?: string): void {
  const r = openBrowserAt?.({ url, anchorNodeId })
  if (!r || r.status === 'invalid') window.open(url, '_blank', 'noopener,noreferrer')
}
