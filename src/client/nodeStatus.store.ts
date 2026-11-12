// Server facts for every mounted status bar (`GET /api/node-status`), fetched in ONE batched request
// for all of them (pages of NODE_STATUS_MAX_IDS): on mount, shortly after any agent status change, and
// every REFRESH_MS while the page is visible. Plus the shared 1s clock the bars read ages from.
import { useEffect, useSyncExternalStore } from 'react'
import { NODE_STATUS_MAX_IDS, NODE_STATUS_PATH, type NodeStatusInfo, type NodeStatusReply } from '../shared/nodeStatusBar'
import { subscribeStatus } from './ws'

/** Background refresh of the server facts (outbox, cost, delegation change without a stream event). */
export const NODE_STATUS_REFRESH_MS = 10_000
/** Coalesces a burst of mounts / status changes into one request. */
export const NODE_STATUS_DEBOUNCE_MS = 500
/** Tick of the ages shown in the bars. */
export const STATUS_TICK_MS = 1000

const watched = new Map<string, number>()
const facts = new Map<string, NodeStatusInfo>()
const listeners = new Set<() => void>()
let refreshTimer: ReturnType<typeof setInterval> | undefined
let soon: ReturnType<typeof setTimeout> | undefined
let unsubStatus: (() => void) | undefined
let fetching = false

const notify = (): void => { for (const l of listeners) l() }

async function refresh(): Promise<void> {
  soon = undefined
  if (fetching || watched.size === 0 || (typeof document !== 'undefined' && document.hidden)) return
  fetching = true
  const ids = [...watched.keys()]
  try {
    for (let i = 0; i < ids.length; i += NODE_STATUS_MAX_IDS) {
      const page = ids.slice(i, i + NODE_STATUS_MAX_IDS)
      const res = await fetch(`${NODE_STATUS_PATH}?ids=${page.map(encodeURIComponent).join(',')}`)
      if (!res.ok) throw new Error(`GET ${NODE_STATUS_PATH} -> ${res.status}`)
      const body = (await res.json()) as NodeStatusReply
      for (const [id, info] of Object.entries(body.nodes)) facts.set(id, info)
    }
    notify()
  } catch (e) {
    // The bars keep the last facts they had; the next tick retries. Ids only, never a body.
    console.warn(`node status refresh for ${ids.length} node(s) failed:`, e instanceof Error ? e.message : e)
  } finally {
    fetching = false
  }
}

/** Fetch soon (debounced): a mount or a status change. */
export function refreshNodeStatusSoon(): void {
  if (!soon) soon = setTimeout(() => { void refresh() }, NODE_STATUS_DEBOUNCE_MS)
}

/** Starts fetching facts for `id` until the returned function is called. */
export function watchNodeStatus(id: string): () => void {
  watched.set(id, (watched.get(id) ?? 0) + 1)
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { void refresh() }, NODE_STATUS_REFRESH_MS)
    unsubStatus = subscribeStatus(() => refreshNodeStatusSoon())
  }
  refreshNodeStatusSoon()
  return () => {
    const n = (watched.get(id) ?? 1) - 1
    if (n > 0) { watched.set(id, n); return }
    watched.delete(id)
    if (watched.size > 0) return
    clearInterval(refreshTimer); refreshTimer = undefined
    unsubStatus?.(); unsubStatus = undefined
  }
}

const subscribeFacts = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Server facts of `id` (undefined until the first answer); `enabled` false = no fetching. */
export function useNodeStatusFacts(id: string, enabled: boolean): NodeStatusInfo | undefined {
  useEffect(() => (enabled ? watchNodeStatus(id) : undefined), [id, enabled])
  return useSyncExternalStore(subscribeFacts, () => facts.get(id))
}

// One interval for every bar on the page, running only while one is mounted.
let now = Date.now()
const tickListeners = new Set<() => void>()
let tick: ReturnType<typeof setInterval> | undefined
function subscribeTick(l: () => void): () => void {
  tickListeners.add(l)
  if (!tick) {
    now = Date.now() // the clock stood still while no bar was mounted
    tick = setInterval(() => { now = Date.now(); for (const t of tickListeners) t() }, STATUS_TICK_MS)
  }
  return () => {
    tickListeners.delete(l)
    if (tickListeners.size === 0 && tick) { clearInterval(tick); tick = undefined }
  }
}

/** Wall clock that advances once per STATUS_TICK_MS, shared by all bars. */
export function useStatusNow(): number {
  return useSyncExternalStore(subscribeTick, () => now)
}

/** Test reset. */
export function __resetNodeStatusForTests(): void {
  watched.clear(); facts.clear()
  if (refreshTimer) clearInterval(refreshTimer)
  if (soon) clearTimeout(soon)
  refreshTimer = soon = undefined
  unsubStatus?.(); unsubStatus = undefined
  fetching = false
  now = Date.now()
}
