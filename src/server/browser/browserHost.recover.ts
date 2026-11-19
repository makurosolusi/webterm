// One recovery for a page that Chromium answers with "Not attached to an active page" (-32000): the page exists but is
// not the active one of its window (a restored/background tab, a window swap after a restart). Every per-page command
// that is safe to repeat goes through `recovering`, so there is a single place that activates the target and retries.
import { createLogger } from '../logs'
import { CDP, isTargetGone } from './cdp.client'
import type { CdpClient } from './cdp.client'
import type { NodeRec } from './browserHost.targets'

const log = createLogger('browser.recover')

/** Idempotent page commands the node needs to keep working; anything else (navigate, input) is never repeated. */
const RECOVERABLE: ReadonlySet<string> = new Set([CDP.startScreencast, CDP.stopLoading, CDP.getNavigationHistory])
export const isRecoverable = (method: string): boolean => RECOVERABLE.has(method)

/** Target of a page session: the view's, or one of the node's background tab pages. */
export function targetOfSession(rec: NodeRec, sid: string): string | undefined {
  if (rec.sessionId === sid) return rec.targetId
  for (const rt of rec.tabs?.rt.values() ?? []) if (rt.sessionId === sid) return rt.targetId
  return undefined
}

/** `send` that, on a gone-page error of a recoverable command, activates the target and retries once; a second failure propagates. */
export function recovering(cdp: CdpClient, targetId: string | undefined): Pick<CdpClient, 'send'> {
  return {
    async send<T = Record<string, unknown>>(method: string, params?: object, sessionId?: string): Promise<T> {
      try {
        return await cdp.send<T>(method, params, sessionId)
      } catch (err) {
        if (!targetId || !isRecoverable(method) || !isTargetGone(err)) throw err
        log.warn('browser.recover', 'page not active; activating its target and retrying once', { method, targetId })
        await cdp.send(CDP.activateTarget, { targetId }).catch((e: unknown) => log.warn('browser.recover', 'activating the target failed', { method, error: e instanceof Error ? e.message : String(e) }))
        return cdp.send<T>(method, params, sessionId)
      }
    },
  }
}
