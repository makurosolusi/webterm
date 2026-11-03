// Status fitur browser di sisi klien: satu fetch bersama (cache modul) dipakai Dock/menu (boleh
// "New Browser"?) dan tiap node (toggle agent, impor cookie). Flag server mati = `/status` 404 =
// `null` = tidak ada UI browser sama sekali; itulah jaminan "flag off, perilaku identik".
import { useEffect, useState } from 'react'
import type { BrowserStatusResp } from '../shared/browser.contract'
import { getBrowserStatus } from './browser.api'

let cached: Promise<BrowserStatusResp | null> | null = null

/** Status server, di-cache. Gagal (flag mati, jaringan, belum login) = `null` dan cache dibuang supaya dicoba lagi. */
export function loadBrowserStatus(): Promise<BrowserStatusResp | null> {
  cached ??= getBrowserStatus().then(
    (s) => { if (!s.enabled) cached = null; return s.enabled ? s : null },
    () => { cached = null; return null }, // flag off => 404; bukan galat yang perlu dilaporkan
  )
  return cached
}

/** Hanya untuk test: lupakan cache. */
export function resetBrowserStatusCache(): void { cached = null }

/** Status browser server, atau `null` selama belum tahu / fitur mati. `ready=false` menunda fetch (belum hydrate/login). */
export function useBrowserStatus(ready = true): BrowserStatusResp | null {
  const [status, setStatus] = useState<BrowserStatusResp | null>(null)
  useEffect(() => {
    if (!ready) return
    let live = true
    void loadBrowserStatus().then((s) => { if (live) setStatus(s) })
    return () => { live = false }
  }, [ready])
  return status
}
