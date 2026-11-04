// Baris menu klik-kanan untuk link di terminal/agent (dipakai TerminalNode dan AgentNode).
import { parseBrowserUrl } from '../shared/browser.url'
import type { MenuRow } from './NodeContextMenu'
import type { OpenBrowserReq, OpenResult } from './browser.open.plan'
import { requestBrowserOffer } from './browserLinkOffer'

export const OPEN_IN_CANVAS_LABEL = 'Open in canvas browser'
export const OPEN_IN_CANVAS_HINT = 'Open this link in a browser node on the canvas.'
export const OPEN_IN_CANVAS_OFF_HINT = 'The canvas browser is off; click to turn it on and open this link.'

/** URL kanonik bila `raw` boleh dibuka di node browser, selain itu null (validasi tunggal: parseBrowserUrl). */
export function openableLink(raw: string | null): string | null {
  if (!raw) return null
  const p = parseBrowserUrl(raw)
  return p.ok ? p.url : null
}

/**
 * Baris "Open in canvas browser" + separator; [] hanya bila tautan tak valid. `open` undefined
 * (kemampuan browser mati) = baris tetap ada dan memunculkan tawaran "Nyalakan" (pola Dock/menu kanvas). `raw` HARUS sudah ditangkap saat menu dibuka: `leave` xterm terpicu begitu
 * kursor pindah ke menu, jadi membacanya saat render membuat baris menghilang.
 */
export function linkRows(
  raw: string | null,
  anchorNodeId: string,
  open: ((r: OpenBrowserReq) => OpenResult) | undefined,
): MenuRow[] {
  const url = openableLink(raw)
  if (!url) return []
  const req = { url, anchorNodeId }
  return [
    open
      ? { label: OPEN_IN_CANVAS_LABEL, hint: OPEN_IN_CANVAS_HINT, onClick: () => { open(req) } }
      : { label: OPEN_IN_CANVAS_LABEL, hint: OPEN_IN_CANVAS_OFF_HINT, onClick: () => requestBrowserOffer(req) },
    { type: 'separator' },
  ]
}
