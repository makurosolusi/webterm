// The server's view of its own link to the Claude API, shared by every consumer (one fetch, one WS subscription).
// Source of truth is the server: GET /api/connectivity on mount and after every WS reconnect, `t:'net'` frames in between.
// Refcounted like chatFeed: the first consumer starts it, the last one resets it. `navigator.onLine` is never read.
import { useEffect, useSyncExternalStore } from 'react'
import type { NetMsg } from '../../shared/protocol'
import { onReconnect, subscribeNet } from '../ws.listeners'

export type NetState = Pick<NetMsg, 'state' | 'since' | 'cause' | 'scope'>

/** loading = first read in flight; unknown = the server cannot say (503 detector off, 403 no credentials, read failed). */
export type NetRaw = { phase: 'loading' | 'unknown' } | { phase: 'known'; net: NetState }

export const CONNECTIVITY_URL = '/api/connectivity'

let raw: NetRaw = { phase: 'loading' }
let refs = 0
let teardown: (() => void) | null = null
let frames = 0 // bumped per WS frame: a fetch that started before a newer frame is stale and dropped
let inflight: AbortController | null = null
const listeners = new Set<() => void>()

function set(next: NetRaw): void {
  raw = next
  for (const l of listeners) l()
}

const isNetState = (v: unknown): v is NetState => {
  const s = v as NetState | null
  return !!s && (s.state === 'online' || s.state === 'degraded' || s.state === 'offline') && typeof s.since === 'number'
}

async function load(): Promise<void> {
  inflight?.abort()
  const ctl = (inflight = new AbortController())
  const at = frames
  try {
    const res = await fetch(CONNECTIVITY_URL, { signal: ctl.signal })
    if (frames !== at) return
    if (res.status === 503 || res.status === 403) return set({ phase: 'unknown' })
    if (!res.ok) throw new Error(`GET ${CONNECTIVITY_URL} -> ${res.status}`)
    const body: unknown = await res.json()
    if (frames !== at) return
    if (!isNetState(body)) throw new Error(`GET ${CONNECTIVITY_URL}: unexpected body shape`)
    set({ phase: 'known', net: { state: body.state, since: body.since, cause: body.cause, scope: body.scope } })
  } catch (err) {
    if (ctl.signal.aborted) return
    console.warn('connectivity: could not read the server state', err)
    // A failed re-read keeps what we knew; only a failed FIRST read leaves us not knowing.
    if (raw.phase === 'loading') set({ phase: 'unknown' })
  }
}

function start(): void {
  const offNet = subscribeNet((m) => {
    frames++
    set({ phase: 'known', net: { state: m.state, since: m.since, cause: m.cause, scope: m.scope } })
  })
  const offReconnect = onReconnect(() => { void load() })
  teardown = () => { offNet(); offReconnect(); inflight?.abort(); inflight = null }
  void load()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Current raw server state; mounts the shared fetch + subscription for as long as the caller is mounted. */
export function useNetRaw(): NetRaw {
  useEffect(() => {
    if (refs++ === 0) start()
    return () => {
      if (--refs === 0) { teardown?.(); teardown = null; raw = { phase: 'loading' } }
    }
  }, [])
  return useSyncExternalStore(subscribe, () => raw)
}
