// CookieInjector nyata (WS-08): tulis/hapus cookie di profil Chromium workspace lewat CDP tingkat browser
// (`Storage.*`, tanpa target halaman). Sengaja BUKAN jalur agent: `cdpAllowlist` tidak mengenal method ini.
// Nilai cookie hanya lewat parameter CDP; tidak pernah di-log (Rule 7).
import { createLogger } from '../logs'
import { CdpClient } from './cdp.client'
import type { BrowserCookie } from './cookieImport.parse'
import { domainKey } from './cookieImport.parse'
import { LaunchError } from './chromium.launch'
import type { BrowserLauncher } from './chromium.launch'
import type { CookieInjector } from '../browserApi'

const log = createLogger('browser.cookies')
/** Detik unix 1 = kedaluwarsa jauh di masa lalu; cara menghapus satu cookie via `Storage.setCookies`. */
const EXPIRED_AT = 1
const STORAGE = { set: 'Storage.setCookies', get: 'Storage.getCookies', clear: 'Storage.clearCookies' } as const

export interface InjectorDeps {
  launcher: BrowserLauncher
  /** Default `CdpClient.connect`; test menyuntik server CDP tiruan. */
  connect?: (wsUrl: string) => Promise<CdpClient>
}

const toCdp = (c: BrowserCookie) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure,
  ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  ...(c.expires > 0 ? { expires: c.expires } : {}),
})

/** Bangun penyuntik di atas peluncur Chromium; koneksi CDP dibuka per operasi lalu ditutup. */
export function createCookieInjector(deps: InjectorDeps): CookieInjector {
  const connect = deps.connect ?? ((u: string) => CdpClient.connect(u))
  async function withBrowser<T>(workspaceId: string, fn: (c: CdpClient) => Promise<T>): Promise<T> {
    const cdp = await connect(await deps.launcher.acquire(workspaceId))
    try { return await fn(cdp) } finally { cdp.close() }
  }
  return {
    inject: (workspaceId, cookies) => withBrowser(workspaceId, async (c) => { await c.send(STORAGE.set, { cookies: cookies.map(toCdp) }) }),
    async remove(workspaceId, domain) {
      try {
        await withBrowser(workspaceId, async (c) => {
          if (domain === undefined) { await c.send(STORAGE.clear, {}); return }
          const want = domainKey(domain)
          const { cookies } = await c.send<{ cookies: Array<{ name: string; domain: string; path: string }> }>(STORAGE.get, {})
          const doomed = cookies.filter((k) => domainKey(k.domain) === want)
          if (doomed.length) await c.send(STORAGE.set, { cookies: doomed.map((k) => ({ name: k.name, value: '', domain: k.domain, path: k.path, expires: EXPIRED_AT })) })
        })
      } catch (err) {
        // Tanpa biner Chromium tak ada profil hidup yang perlu dibersihkan; vault sudah dihapus pemanggil.
        if (!(err instanceof LaunchError && err.code === 'no_binary')) throw err
        log.warn('browser.cookies', 'profile cleanup skipped: no chromium binary', { ids: { workspaceId } })
      }
    },
  }
}
