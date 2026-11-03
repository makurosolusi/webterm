// Capability browser untuk sesi PTY agent: dua token (`browser.read` / `browser.act`) yang di-scope ke SATU node
// browser (`node:<id>`) dan disuntik sebagai env anak. Node-token TIDAK dipakai untuk jalur ini (default-deny tetap).
// Nilai token tidak pernah dilog (Rule 7). Env PTY tetap sejak spawn, jadi token diperbarui geser lewat `renew`.
import { BROWSER_CAPS, BROWSER_KIND } from '../../shared/browser.contract'
import type { BrowserCap } from '../../shared/browser.contract'
import type { Workspace } from '../../shared/workspace'
import { MAX_TTL_MS } from '../control/capabilities'
import type { CapabilityStore } from '../control/capabilities'
import type { BrowserSessionHook } from '../sessionsTypes'
import { BROWSER_ACT_CAP_ENV, BROWSER_NODE_ID_ENV, BROWSER_READ_CAP_ENV } from '../browserAgentShim'

export interface SessionCapsDeps {
  store: Pick<CapabilityStore, 'mint' | 'revoke'>
  /** Flag induk + `WEBTERM_BROWSER_AGENT`; off = sesi tidak mendapat apa pun. */
  agentEnabled(): boolean
  workspaces(): Workspace[]
}

/** Node browser target sesi: yang terhubung lewat bridge, selain itu satu-satunya node browser di board. */
export function pickBrowserNode(workspaces: Workspace[], sessionId: string): string | undefined {
  const ws = workspaces.find((w) => w.nodes.some((n) => n.id === sessionId))
  if (!ws) return undefined
  const browsers = new Set(ws.nodes.filter((n) => n.kind === BROWSER_KIND).map((n) => n.id))
  for (const b of ws.bridges) {
    if (b.source === sessionId && browsers.has(b.target)) return b.target
    if (b.target === sessionId && browsers.has(b.source)) return b.source
  }
  return browsers.size === 1 ? [...browsers][0] : undefined
}

export function createBrowserSessionHook(deps: SessionCapsDeps): BrowserSessionHook {
  const minted = new Map<string, string[]>()
  const release = (sessionId: string) => {
    for (const t of minted.get(sessionId) ?? []) deps.store.revoke(t)
    minted.delete(sessionId)
  }
  return {
    release,
    envFor(sessionId, agentId): Record<string, string> {
      const nodeId = agentId && deps.agentEnabled() ? pickBrowserNode(deps.workspaces(), sessionId) : undefined
      if (!nodeId) return {}
      release(sessionId) // spawn ulang id yang sama: token lama tidak boleh tersisa
      const mint = (verb: BrowserCap) =>
        deps.store.mint({ verb, resource: `node:${nodeId}`, ttlMs: MAX_TTL_MS, mintedBy: `session:${sessionId}` })
      const read = mint(BROWSER_CAPS.read)
      const act = mint(BROWSER_CAPS.act)
      minted.set(sessionId, [read, act])
      return { [BROWSER_READ_CAP_ENV]: read, [BROWSER_ACT_CAP_ENV]: act, [BROWSER_NODE_ID_ENV]: nodeId }
    },
  }
}
