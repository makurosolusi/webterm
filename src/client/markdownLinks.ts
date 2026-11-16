// Links inside RENDERED MARKDOWN must never navigate webterm's own tab.
//
// `renderMarkdown` keeps an anchor's href exactly as written, and agents write relative links all
// the time (`[pty.ts](src/server/pty.ts:41)`). Left alone, a plain click resolves that against the
// app URL and the whole canvas is gone; a middle click opens a stray 404 tab. Because the folder of
// the previewed file is known, a local link opens the file in an editor node instead; `#anchor`
// scrolls inside the preview; `mailto:` and `tel:` keep the browser default, which hands them to
// the OS without leaving the page.

export type MarkdownLinkDecision =
  | { action: 'external'; url: string }
  | { action: 'local'; path: string; line?: number; column?: number }
  | { action: 'anchor'; id: string }
  | { action: 'native' }
  | { action: 'ignore' }

const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:'])
const OS_HANDLED_SCHEMES: ReadonlySet<string> = new Set(['mailto:', 'tel:'])

/** Percent-decode, leaving the text untouched when it is not valid percent-encoding. */
function decodeLoose(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Join `rel` onto folder `dir` and fold `.` and `..`; a leading `/` in `rel` ignores `dir`. Never climbs above `/`. */
export function resolvePath(dir: string, rel: string): string {
  const joined = rel.startsWith('/') ? rel : `${dir}/${rel}`
  const folded: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') folded.pop()
    else folded.push(part)
  }
  return `/${folded.join('/')}`
}

/** Parse an absolute URL; null for relative or protocol-relative hrefs (which `new URL` rejects without a base). */
function parseAbsolute(href: string): URL | null {
  try {
    return new URL(href)
  } catch {
    return null
  }
}

/** Split a trailing `:line` or `:line:column` (the form agents write) off a decoded path. */
function splitLineSuffix(path: string): { path: string; line?: number; column?: number } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(path)
  if (!match) return { path }
  return { path: match[1], line: Number(match[2]), column: match[3] ? Number(match[3]) : undefined }
}

/**
 * What a click on an anchor with RAW `href` attribute `rawHref` should do. It decides on the raw
 * attribute, never on the resolved `a.href`: resolving against the app document is exactly what
 * turns a harmless relative path into a navigation. `baseDir` is the folder the Markdown lives in;
 * '' means unknown (chat), where only absolute paths can be opened.
 */
export function decideMarkdownLinkClick(rawHref: string, baseDir = ''): MarkdownLinkDecision {
  const href = rawHref.trim()
  if (href === '') return { action: 'ignore' }
  if (href.startsWith('#')) {
    return href.length > 1 ? { action: 'anchor', id: decodeLoose(href.slice(1)) } : { action: 'ignore' }
  }

  const absolute = parseAbsolute(href)
  if (absolute) {
    if (WEB_SCHEMES.has(absolute.protocol)) return { action: 'external', url: absolute.href }
    if (OS_HANDLED_SCHEMES.has(absolute.protocol)) return { action: 'native' }
    if (absolute.protocol !== 'file:') return { action: 'ignore' }
  }

  const rawPath = absolute ? absolute.pathname : href.replace(/[?#].*$/, '')
  if (!rawPath || rawPath.startsWith('//')) return { action: 'ignore' }
  const target = splitLineSuffix(decodeLoose(rawPath))
  if (!target.path.startsWith('/') && !baseDir) return { action: 'ignore' }

  const path = resolvePath(baseDir, target.path)
  return target.line === undefined
    ? { action: 'local', path }
    : { action: 'local', path, line: target.line, column: target.column }
}

export interface MarkdownLinkDeps {
  openUrl(url: string): void
  openFile(path: string, line?: number, column?: number): void
  scrollToAnchor?(id: string): void
}

interface LinkEvent {
  target: EventTarget | null
  button: number
  defaultPrevented: boolean
  preventDefault(): void
}

/**
 * Handler for `onClick` and `onAuxClick` on a rendered-Markdown container. Primary and middle
 * buttons only: a middle click never fires `click`, and its `auxclick` default opens a new tab.
 * Modifier clicks are routed the same way, since the default would open the unresolvable relative
 * URL anyway.
 */
export function handleMarkdownLinkEvent(e: LinkEvent, baseDir: string, deps: MarkdownLinkDeps): void {
  if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return
  const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null
  if (!anchor) return
  const decision = decideMarkdownLinkClick(anchor.getAttribute('href') ?? '', baseDir)
  if (decision.action === 'native') return
  e.preventDefault()
  switch (decision.action) {
    case 'external':
      deps.openUrl(decision.url)
      break
    case 'local':
      deps.openFile(decision.path, decision.line, decision.column)
      break
    case 'anchor':
      deps.scrollToAnchor?.(decision.id)
      break
  }
}

type OpenBrowser = (req: { url: string; anchorNodeId?: string }) => { status: string }

/** Open a web link in a browser node on the canvas, or in a new browser tab when that node is off or refuses the URL. */
export function openWebLink(openBrowserAt: OpenBrowser | undefined, url: string, anchorNodeId?: string): void {
  const result = openBrowserAt?.({ url, anchorNodeId })
  if (!result || result.status === 'invalid') window.open(url, '_blank', 'noopener,noreferrer')
}
