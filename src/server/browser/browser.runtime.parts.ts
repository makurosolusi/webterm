// Pernak-pernik perakitan runtime browser yang dipisah agar `browser.runtime.ts` tetap ramping.
import { BlockedError, ENV_BROWSER } from '../../shared/browser.contract'
import { flagOr } from '../envFlag'
import type { BrowserHost } from './browserHost.service'
import type { BrowserLifecycle } from './browserLifecycle.service'
import type { GatewayHost } from './browserWs.viewers'

/**
 * Host untuk gateway: `open` lewat `BrowserLifecycle.attach` supaya batas MAX_LIVE dipatuhi (penuh = `blocked`),
 * sisanya didelegasikan apa adanya ke host. Proxy (bukan spread) karena method host bergantung pada `this`.
 */
export function adaptGatewayHost(host: BrowserHost, lifecycle: BrowserLifecycle): GatewayHost {
  return new Proxy(host, {
    get(target, prop) {
      if (prop === 'open') {
        return async (nodeId: string, workspaceId: string, url?: string) => {
          const r = await lifecycle.attach(nodeId, workspaceId, url)
          if (!r.ok) throw new BlockedError(r.blocked)
          return r.state
        }
      }
      const v: unknown = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** Impor cookie dari berkas ikut menyala bersama browser (seperti Orca); hanya `off` eksplisit yang mematikan. */
export const cookieImportOn = (env: Record<string, string | undefined>): boolean => flagOr(env[ENV_BROWSER.cookieImport], true)
