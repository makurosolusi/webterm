// The ONLY place client code sends a link out of webterm's own tab. webterm's UI runs in the user's browser, so a bare
// `window.open` / `<a target="_blank">` lands in the machine's Chrome. See docs/decisions/canvas-containment.md.
import { closeNotice, showNotice } from './workspaceSave.notice'
import { writeClipboard } from './browser.clipboard'

type OpenBrowser = (req: { url: string; anchorNodeId?: string }) => { status: string }

export const CANVAS_LINK_TEXT = {
  blockedTitle: 'Could not open the link in the canvas browser',
  blockedMessage: 'The browser node is off or refused this address. Nothing was opened outside webterm.',
  invalidTitle: 'Only http and https links open in the canvas browser',
  openSystem: 'Open in system browser',
  copy: 'Copy link',
}
export const CANVAS_LINK_NOTICE_KEY = 'webterm-canvas-link'

/** The http(s) form of `url`, or null for any other scheme (javascript:, file:, ...). */
export function webUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** Explicit, user-labelled exit to the machine browser ("Open in system browser"). Never call it from automatic paths. */
export function openInSystemBrowser(url: string): void {
  const safe = webUrl(url)
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer')
}

/** Open `url` in a browser node on the canvas. When that is impossible, show a notice offering the explicit exit; never opens outside by itself. */
export function openLinkInCanvas(url: string, opts: { openBrowserAt?: OpenBrowser; anchorNodeId?: string } = {}): 'canvas' | 'blocked' | 'invalid' {
  const safe = webUrl(url)
  if (!safe) {
    showNotice(CANVAS_LINK_NOTICE_KEY, { title: CANVAS_LINK_TEXT.invalidTitle, severity: 'warning' })
    return 'invalid'
  }
  const result = opts.openBrowserAt?.({ url: safe, anchorNodeId: opts.anchorNodeId })
  if (result && result.status !== 'invalid') return 'canvas'
  showNotice(CANVAS_LINK_NOTICE_KEY, {
    title: CANVAS_LINK_TEXT.blockedTitle,
    message: `${CANVAS_LINK_TEXT.blockedMessage} ${new URL(safe).host}`,
    severity: 'warning',
    actions: [
      { label: CANVAS_LINK_TEXT.openSystem, onClick: () => { openInSystemBrowser(safe); closeNotice(CANVAS_LINK_NOTICE_KEY) } },
      { label: CANVAS_LINK_TEXT.copy, onClick: () => {
        void writeClipboard(safe).then((r) => { if (!r.ok) console.warn('canvasLinks.copy failed', r.error) })
        closeNotice(CANVAS_LINK_NOTICE_KEY)
      } },
    ],
  })
  return 'blocked'
}
