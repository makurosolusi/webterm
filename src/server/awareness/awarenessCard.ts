// The per-node identifier card (PLAN F2-e): who/where this node is and what is wired to it, with the
// last known status of each wired peer. One subscriber on the Senses event bus keeps a cache per node
// and drops entries when an event says they changed, so a hook reply reads a cached string instead of
// re-walking the workspace (Letta shared blocks: rendered once, served to every reader until changed).
//
// Invalidation, by event:
//  - `edge.change` (cable drawn/removed, peer renamed): every card of that workspace;
//  - `hook.*` carrying a new status, `pty.exit`: the cards that list that node as a peer;
//  - own title / cwd / board rename emits no event, so the cache entry also stores an identity
//    signature compared against the workspace the caller already has in hand.
// Pure apart from the injected bus: no sqlite, no fs (vitest node-env safe).
import type { Workspace } from '../../shared/workspace'
import { BROWSER_KIND } from '../../shared/browser.contract'
import type { EventBus } from '../events/eventBus'
import { linkedPeerIds } from '../contextLinkRoute'
import { oneLine } from '../linkNote'

export const CARD_MAX_CHARS = 1200
/** Per-category list cap; the rest is a count. */
export const CARD_MAX_LISTED = 8

interface Entry { text: string; sig: string; wsId: string; peers: Set<string> }

const identitySig = (ws: Workspace, nodeId: string): string => {
  const n = ws.nodes.find((x) => x.id === nodeId)
  return [ws.id, ws.name, ws.cwd ?? '', n?.title ?? '', n?.cwd ?? ''].join('\u0000')
}

function list(label: string, items: string[]): string | null {
  if (!items.length) return null
  const more = items.length > CARD_MAX_LISTED ? `; +${items.length - CARD_MAX_LISTED} more` : ''
  return `${label}: ${items.slice(0, CARD_MAX_LISTED).join('; ')}${more}`
}

/** Pure. The card text for `nodeId`; `statusOf` = last known peer status (undefined = unknown). */
export function renderCard(ws: Workspace, nodeId: string, statusOf: (id: string) => string | undefined): { text: string; peers: Set<string> } {
  const self = ws.nodes.find((n) => n.id === nodeId)
  const peers = linkedPeerIds(ws, nodeId)
  const wired = ws.nodes.filter((n) => peers.has(n.id))
  const q = (n: { id: string; title?: string }, extra = ''): string => `"${oneLine(n.title || n.id)}" (id ${oneLine(n.id)}${extra})`
  const browsers = wired.filter((n) => n.kind === BROWSER_KIND).map((n) => q(n))
  const diffs = wired.filter((n) => n.kind === 'diff').map((n) => q(n))
  const agents = wired.filter((n) => n.kind !== BROWSER_KIND && n.kind !== 'diff').map((n) => {
    const s = statusOf(n.id)
    return q(n, `${n.agentId ? `, ${oneLine(n.agentId)}` : ''}${s ? `, ${s}` : ''}`)
  })
  const lines = [
    `webterm card: node "${oneLine(self?.title || nodeId)}" (id ${oneLine(nodeId)}) on board "${oneLine(ws.name || ws.id)}", cwd ${oneLine(self?.cwd || ws.cwd || '(not set)')}.`,
    list('Wired peers', agents), list('Wired browsers', browsers), list('Wired diffs', diffs),
  ].filter((l): l is string => l !== null)
  return { text: lines.join('\n').slice(0, CARD_MAX_CHARS), peers }
}

/** One subscriber for the process; `dispose` unsubscribes (tests). */
export function createAwarenessCards(bus: Pick<EventBus, 'subscribe'>) {
  const cards = new Map<string, Entry>()
  const statuses = new Map<string, string>()
  let builds = 0
  const dropPeersOf = (id: string): void => { for (const [k, e] of cards) if (e.peers.has(id)) cards.delete(k) }
  const offs = [
    bus.subscribe('edge.change', (e) => { for (const [k, c] of cards) if (c.wsId === e.workspaceId) cards.delete(k) }),
    bus.subscribe('hook.*', (e) => {
      const s = (e.payload as { status?: unknown } | null)?.status
      if (!e.nodeId || typeof s !== 'string' || statuses.get(e.nodeId) === s) return
      statuses.set(e.nodeId, s)
      dropPeersOf(e.nodeId)
    }),
    bus.subscribe('pty.exit', (e) => {
      if (!e.nodeId) return
      statuses.set(e.nodeId, 'exited')
      cards.delete(e.nodeId)
      dropPeersOf(e.nodeId)
    }),
  ]
  return {
    /** Cached card; rebuilt only after an invalidating event or an identity change. */
    card(nodeId: string, ws: Workspace): string {
      const sig = identitySig(ws, nodeId)
      const hit = cards.get(nodeId)
      if (hit && hit.sig === sig && hit.wsId === ws.id) return hit.text
      builds += 1
      const { text, peers } = renderCard(ws, nodeId, (id) => statuses.get(id))
      cards.set(nodeId, { text, sig, wsId: ws.id, peers })
      return text
    },
    forget(nodeId: string): void { cards.delete(nodeId); statuses.delete(nodeId) },
    /** How many times a card was rendered (tests assert the cache holds). */
    get builds(): number { return builds },
    dispose(): void { for (const off of offs) off() },
  }
}

export type AwarenessCards = ReturnType<typeof createAwarenessCards>
