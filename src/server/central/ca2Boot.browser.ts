// Wires the central agent's browser tools (BR-WS12) to the live browser runtime. Everything is resolved lazily
// because CA2 boots before the browser runtime starts; with the browser feature flag off nothing is wired at all.
import { BROWSER_CONTROL_PREFIX, ENV_BROWSER } from '../../shared/browser.contract'
import { flagOn } from '../envFlag'
import { type BrowserRuntime, activeBrowser } from '../browser/browser.state'
import { CAPABILITY_HEADER } from '../auth'
import type { CapabilityStore } from '../control/capabilities'
import { allows, clampTtl } from '../control/capabilities'
import type { ControlCapabilities } from '../control/controlTypes'
import type { BrowserToolDeps } from './tools/defs/browser.status'

/** Lifetime of the per-call `browser.act` capability; it is revoked right after the call, this is only the backstop. */
export const BROWSER_CAP_TTL_MS = 30_000
const MINTED_BY = 'central'

export interface BrowserBootSources {
  store: Pick<CapabilityStore, 'mint' | 'revoke' | 'verify'>
  /** Live browser runtime, null while the feature is off or not started yet. */
  active?: () => BrowserRuntime | null
}

/** Browser tool ports for `registerCa2Tools`, or undefined when the browser feature flag is off. */
export function createBrowserToolDeps(env: Record<string, string | undefined>, src: BrowserBootSources): BrowserToolDeps | undefined {
  if (!flagOn(env[ENV_BROWSER.enabled])) return undefined
  const active = src.active ?? activeBrowser
  const caps: ControlCapabilities = {
    verify: (token, now) => src.store.verify(token, now),
    allows,
    mint: (o) => ({ token: src.store.mint(o), expiresAt: Date.now() + clampTtl(o.ttlMs) }),
  }
  return {
    state: (nodeId) => active()?.state(nodeId),
    listDomains: (workspaceId) => active()?.listDomains(workspaceId).map(({ domain }) => ({ domain })) ?? [],
    async control(nodeId, verb, body) {
      const rt = active()
      if (!rt) return { status: 503, body: { error: 'disabled' } }
      const token = src.store.mint({ verb: 'browser.act', resource: `node:${nodeId}`, ttlMs: BROWSER_CAP_TTL_MS, mintedBy: MINTED_BY })
      try {
        const res = await rt.control({ method: 'POST', path: `${BROWSER_CONTROL_PREFIX}/${nodeId}/${verb}`, headers: { [CAPABILITY_HEADER]: token }, body }, caps)
        return res ?? { status: 404, body: { error: 'not_found' } }
      } finally {
        src.store.revoke(token)
      }
    },
  }
}
