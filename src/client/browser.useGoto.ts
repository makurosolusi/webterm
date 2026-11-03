// Memuat URL awal node browser baru. Server membaca URL awal dari workspace TERSIMPAN (debounce simpan
// klien 400 ms), jadi attach bisa mendarat di about:blank; kita susul dengan satu `nav go` (kontrak WS tetap).
import { useEffect, useRef } from 'react'
import type { BrowserState } from '../shared/browser.contract'
import type { BrowserSession } from './browser.useSession'

const BLANK_URL = 'about:blank'

/** True bila URL kosong atau halaman kosong bawaan Chromium. */
export const isBlankUrl = (u: string | undefined | null): boolean => !u || u === BLANK_URL

/** Mirror `state.url` ke `data.url` hanya untuk halaman nyata yang sudah selesai dan tidak diblokir. */
export function shouldMirrorUrl(state: BrowserState | undefined, dataUrl: string | undefined): boolean {
  return !!state && !isBlankUrl(state.url) && !state.loading && !state.blocked && state.url !== dataUrl
}

/**
 * Kirim `nav go` ke `want` TEPAT sekali per mount, setelah state pertama tiba (sudah attach) dan sesi
 * masih kosong. Sekali saja supaya penolakan (lease_agent/blocked) tidak menjadi loop.
 */
export function useGoto({ want, state, send }: { want?: string; state?: BrowserState; send: BrowserSession['send'] }): void {
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !state || !want || !isBlankUrl(state.url) || state.blocked) return
    sent.current = true
    send({ t: 'nav', action: 'go', url: want })
  }, [want, state, send])
}
