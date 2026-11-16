// Short-lived record of what Central just did to each node (`t:'act'` frames), so the canvas can mark
// it without moving the camera or touching selection. Ids and verbs only (Rule 12): titles come from the board.
import { useEffect, useSyncExternalStore } from 'react'
import type { ActMsg } from '../shared/protocol'
import { subscribeAct } from './ws'

/** How long a node stays marked after Central's last action on it. */
export const ACT_TTL_MS = 20_000
/** Most nodes held at once; a further one evicts the oldest and only bumps `dropped` (bounded memory). */
export const ACT_MAX_HELD = 50
/** Verbs that create a node: the chip says "New" instead of "just now". */
const NEW_VERBS: ReadonlySet<string> = new Set(['spawned', 'opened'])
/** Verbs that act along a cable: agent <-> browser. */
const CABLE_VERBS: ReadonlySet<string> = new Set(['drove', 'wired'])

export const isNewVerb = (verb: string): boolean => NEW_VERBS.has(verb)
export const isCableVerb = (verb: string): boolean => CABLE_VERBS.has(verb)

export interface ActEntry { nodeId: string; nodeId2?: string; verb: string; tool: string; workspaceId?: string; n: number; ts: number; seq: number }
export interface ActSnapshot {
  /** Newest first. */
  entries: readonly ActEntry[]
  /** Nodes evicted past `ACT_MAX_HELD` while others were still held. */
  dropped: number
}
export interface ActStore {
  record(msg: ActMsg): void
  getSnapshot(): ActSnapshot
  subscribe(cb: () => void): () => void
  /** Clears the expiry timer (held entries stay). */
  dispose(): void
}
interface StoreOptions { ttlMs?: number; maxHeld?: number; now?: () => number }

const EMPTY: ActSnapshot = { entries: [], dropped: 0 }

/** One store per call: entries merge per node (`n` adds up, latest verb wins) and expire `ttlMs` after their last frame. */
export function createActStore({ ttlMs = ACT_TTL_MS, maxHeld = ACT_MAX_HELD, now = Date.now }: StoreOptions = {}): ActStore {
  const held = new Map<string, ActEntry>()
  const listeners = new Set<() => void>()
  let dropped = 0
  let seq = 0
  let snap: ActSnapshot = EMPTY
  let timer: ReturnType<typeof setTimeout> | null = null

  const publish = (): void => {
    snap = held.size === 0 ? EMPTY : { entries: [...held.values()].sort((a, b) => b.seq - a.seq), dropped }
    for (const l of [...listeners]) l()
  }
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (held.size === 0) return
    const oldest = Math.min(...[...held.values()].map((e) => e.ts))
    timer = setTimeout(() => {
      timer = null
      const cut = now() - ttlMs
      for (const [id, e] of held) if (e.ts <= cut) held.delete(id)
      if (held.size === 0) dropped = 0
      publish()
      arm()
    }, Math.max(0, oldest + ttlMs - now()))
  }

  return {
    record(msg) {
      const prev = held.get(msg.nodeId)
      held.delete(msg.nodeId) // re-insert keeps Map order = recency
      held.set(msg.nodeId, {
        nodeId: msg.nodeId, ...(msg.nodeId2 ? { nodeId2: msg.nodeId2 } : {}), verb: msg.verb, tool: msg.tool,
        ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}), n: (prev?.n ?? 0) + Math.max(1, msg.n), ts: now(), seq: ++seq,
      })
      while (held.size > maxHeld) { held.delete(held.keys().next().value as string); dropped += 1 }
      publish()
      arm()
    },
    getSnapshot: () => snap,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    dispose() { if (timer) clearTimeout(timer); timer = null },
  }
}

// One store for the page, not one per board: the canvas remounts on every board switch (BoardHost key),
// and a record that died with it would erase the mark of the node the user just clicked "Open" for.
let shared: ActStore | null = null
let users = 0
let off: (() => void) | null = null
const sharedStore = (): ActStore => (shared ??= createActStore())

/** Test seam: forgets the shared store and its subscription. */
export function resetSharedActStore(): void {
  off?.(); off = null; users = 0
  shared?.dispose(); shared = null
}

/** The live snapshot. The first mounted user opens the single `subscribeAct` hookup; the last one closes it. */
export function useCentralAct(): ActSnapshot {
  const store = sharedStore()
  useEffect(() => {
    if (users++ === 0) off = subscribeAct((m) => sharedStore().record(m))
    return () => { if (--users === 0) { off?.(); off = null } }
  }, [])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

// "Show on canvas" for surfaces far from the canvas (the chat's tool cards): the mounted board registers how
// to bring a node into view, they just ask. Always a user click; false = this board has no such node.
let showHandler: ((nodeId: string) => boolean) | null = null
/** The mounted canvas registers its reveal here (null on unmount). */
export function setShowNodeHandler(fn: ((nodeId: string) => boolean) | null): void { showHandler = fn }
/** Bring `nodeId` into view (user gesture). False when no canvas is mounted or the node is not on it. */
export const showNodeOnCanvas = (nodeId: string): boolean => showHandler?.(nodeId) ?? false
