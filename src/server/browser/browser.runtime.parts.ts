// Pernak-pernik perakitan runtime browser yang dipisah agar `browser.runtime.ts` tetap ramping.
import { BlockedError, ENV_BROWSER } from '../../shared/browser.contract'
import type { NAV_ACTIONS } from '../../shared/browser.contract'
import { flagOr } from '../envFlag'
import type { BrowserHost } from './browserHost.service'
import type { BrowserLifecycle } from './browserLifecycle.service'
import type { GatewayHost } from './browserWs.viewers'
import { BrowserError } from './browserHost.targets'

/**
 * The single gate for rebuilding a `discarded` node's page: via `lifecycle.attach` so it takes a MAX_LIVE slot and is
 * tracked (BlockedError 'max_live' when full). Returns false when the node is not discarded (caller proceeds as usual).
 * A guard-blocked url still goes through `host.navigate`, which throws the typed BlockedError.
 */
export async function wakeDiscarded(host: BrowserHost, lifecycle: BrowserLifecycle, nodeId: string, url?: string): Promise<boolean> {
  if (host.state(nodeId)?.live !== 'discarded') return false
  const ws = host.workspaceOf(nodeId)
  if (!ws) throw new BrowserError('not_found', `browser node ${nodeId} is not known to the browser host`)
  const r = await lifecycle.attach(nodeId, ws, url || undefined)
  if (!r.ok) throw new BlockedError(r.blocked)
  if (url && host.state(nodeId)?.blocked) await host.navigate(nodeId, url)
  return true
}

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
      if (prop === 'navigate') return async (nodeId: string, url: string) => { if (!(await wakeDiscarded(host, lifecycle, nodeId, url))) await host.navigate(nodeId, url) }
      if (prop === 'navAction') {
        return async (nodeId: string, action: (typeof NAV_ACTIONS)[number], url?: string) => {
          // go -> navigate (gated above); reload of a discarded node reopens its page, so it is gated too.
          if (action === 'go' && url && (await wakeDiscarded(host, lifecycle, nodeId, url))) return
          if (action === 'reload' && (await wakeDiscarded(host, lifecycle, nodeId, host.state(nodeId)?.url))) return
          await host.navAction(nodeId, action, url)
        }
      }
      const v: unknown = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** Impor cookie dari berkas ikut menyala bersama browser (seperti Orca); hanya `off` eksplisit yang mematikan. */
export const cookieImportOn = (env: Record<string, string | undefined>): boolean => flagOr(env[ENV_BROWSER.cookieImport], true)

/** Audio capture of browser nodes: default ON, only an explicit `off` (WEBTERM_BROWSER_AUDIO) kills it. */
export const audioOn = (env: Record<string, string | undefined>): boolean => flagOr(env[ENV_BROWSER.audio], true)

/** Kendali agent atas node browser default ON (webterm alat developer); hanya `off` eksplisit yang mematikan. */
export const agentControlOn = (env: Record<string, string | undefined>): boolean => flagOr(env[ENV_BROWSER.agent], true)
