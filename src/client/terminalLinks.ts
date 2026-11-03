// Baris menu klik-kanan untuk link di terminal/agent (dipakai TerminalNode dan AgentNode).
import { parseBrowserUrl } from '../shared/browser.url'
import type { MenuRow } from './NodeContextMenu'
import type { OpenBrowserReq, OpenResult } from './browser.open.plan'

export const OPEN_IN_CANVAS_LABEL = 'Open in canvas browser'
export const OPEN_IN_CANVAS_HINT = 'Buka link ini di node browser di canvas.'

/** URL kanonik bila `raw` boleh dibuka di node browser, selain itu null (validasi tunggal: parseBrowserUrl). */
export function openableLink(raw: string | null): string | null {
  if (!raw) return null
  const p = parseBrowserUrl(raw)
  return p.ok ? p.url : null
}

/**
 * Baris "Open in canvas browser" + separator; [] bila `open` undefined (flag browser mati) atau
 * tautan tak valid. `raw` HARUS sudah ditangkap saat menu dibuka: `leave` xterm terpicu begitu
 * kursor pindah ke menu, jadi membacanya saat render membuat baris menghilang.
 */
export function linkRows(
  raw: string | null,
  anchorNodeId: string,
  open: ((r: OpenBrowserReq) => OpenResult) | undefined,
): MenuRow[] {
  const url = openableLink(raw)
  if (!url || !open) return []
  return [
    { label: OPEN_IN_CANVAS_LABEL, hint: OPEN_IN_CANVAS_HINT, onClick: () => { open({ url, anchorNodeId }) } },
    { type: 'separator' },
  ]
}
