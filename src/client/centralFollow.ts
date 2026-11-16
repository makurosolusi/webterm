// Follow: the camera trails Central's work (agent terminal, then its browser) so the user sees it without hunting.
// ON by default; yields to the user (pause after any canvas interaction), never steals keyboard focus, never
// changes selection or board. It only ever moves the camera through revealNode (nodeReveal.ts).
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import type { ActEntry } from './centralAct.store'
import { ACT_TTL_MS } from './centralAct.store'
import { closestNodeRoot } from './nodeRoot'
import { rectOfNode, revealNode } from './nodeReveal'
import { focusedNodeId } from './presencePing'
import { getTabLayout } from './tabLayout.store'

/** Least time the camera rests on one target before the next (counted from the end of the camera animation). */
export const FOLLOW_DWELL_MS = 1500
/** After a user canvas interaction Follow stays paused this long (guess: long enough to finish a gesture, short enough to resume). */
export const FOLLOW_PAUSE_MS = 10_000
/** Queued targets kept; beyond this the camera jumps to the newest and the rest count as "N more". */
export const FOLLOW_QUEUE_MAX = 3
/** Recheck interval while the queue is blocked (paused, held, hidden tab). */
const RETRY_MS = 1000
/** How long a target whose node is not on the board yet is waited for. */
const NODE_WAIT_MS = 3000
const NODE_WAIT_RETRY_MS = 300
const FOLLOW_KEY = 'webterm.centralFollow'
/** Verbs that move the subject; `closed` never does. */
const FOLLOW_VERBS: ReadonlySet<string> = new Set(['spawned', 'opened', 'drove', 'prompted', 'typed', 'wired'])

export type FollowStatus = 'following' | 'paused' | 'held' | 'off'
export interface FollowView {
  on: boolean
  status: FollowStatus
  /** Seconds until a pause ends (status `paused`). */
  resumeInS: number
  /** The node Central acted on while the user was elsewhere (status `held`): the tray offers Show instead. */
  heldNodeId: string | null
  /** Targets still waiting, plus ones skipped by the queue cap. */
  more: number
}

/** Per-viewer switch; default ON. Storage can throw (private window): then ON and not remembered. */
export function readFollowOn(): boolean {
  try { return localStorage.getItem(FOLLOW_KEY) !== 'off' } catch { return true }
}
function writeFollowOn(on: boolean): void {
  try { localStorage.setItem(FOLLOW_KEY, on ? 'on' : 'off') } catch (err) {
    console.warn('central.follow: could not remember the switch', err instanceof Error ? err.message : 'unknown')
  }
}

export interface FollowDeps {
  getRf(): Parameters<typeof revealNode>[0]
  workspaceId(): string | null
  focusedId?(): string | null
  isHidden?(): boolean
  isTabMode?(): boolean
  now?(): number
}

/** The follow state machine (no React): `feed` Central's acts, `userMoved` on canvas interaction. */
export function createFollowController(d: FollowDeps) {
  const now = d.now ?? Date.now
  const focusedId = d.focusedId ?? focusedNodeId
  const isHidden = d.isHidden ?? (() => document.hidden)
  const isTabMode = d.isTabMode ?? (() => getTabLayout().mode === 'tabs')
  const listeners = new Set<() => void>()
  let on = readFollowOn()
  let lastUser = -Infinity
  let pointerDown = false
  let queue: { id: string; ts: number }[] = []
  let skipped = 0
  let current: string | null = null
  let busy = false
  let lastSeq = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let dwell: ReturnType<typeof setTimeout> | null = null // separate: a new act must not cut the rest short
  let view: FollowView = { on, status: on ? 'following' : 'off', resumeInS: 0, heldNodeId: null, more: 0 }

  const paused = (): boolean => pointerDown || now() - lastUser < FOLLOW_PAUSE_MS
  const heldBy = (id: string): boolean => { const f = focusedId(); return f !== null && f !== id }
  const compute = (): FollowView => {
    const head = queue[0]
    const status: FollowStatus = !on ? 'off' : paused() ? 'paused' : head && heldBy(head.id) ? 'held' : 'following'
    return {
      on, status, resumeInS: status === 'paused' ? Math.max(1, Math.ceil((lastUser + FOLLOW_PAUSE_MS - now()) / 1000)) : 0,
      heldNodeId: status === 'held' && head ? head.id : null, more: queue.length + skipped,
    }
  }
  const same = (a: FollowView, b: FollowView): boolean => a.on === b.on && a.status === b.status && a.resumeInS === b.resumeInS && a.heldNodeId === b.heldNodeId && a.more === b.more
  const notify = (): void => {
    const next = compute()
    if (same(view, next)) return
    view = next
    for (const l of [...listeners]) l()
  }
  const later = (ms: number): void => { if (timer) clearTimeout(timer); timer = setTimeout(pump, ms) }

  function pump(): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (busy || !on) return notify()
    queue = queue.filter((q) => now() - q.ts < ACT_TTL_MS) // a target this old is history, not news
    if (queue.length === 0) { skipped = 0; notify(); if (paused()) later(RETRY_MS); return }
    const head = queue[0]!
    if (paused() || isHidden() || heldBy(head.id)) { notify(); later(RETRY_MS); return }
    const rf = d.getRf()
    const n = rf?.getNode?.(head.id)
    // A fresh spawn can reach us a beat before the board state has the node: wait briefly, then treat it as closed / another board (skip, never switch).
    if ((!rf || !n) && now() - head.ts < NODE_WAIT_MS) { later(NODE_WAIT_RETRY_MS); return }
    queue.shift()
    if (!rf || !n) return pump()
    busy = true
    current = head.id
    notify()
    revealNode(rf, head.id, rectOfNode(n), { focus: false, zoomToReadable: true })
      .catch((err: unknown) => { console.warn('central.follow: camera move failed', err instanceof Error ? err.message : 'unknown') })
      .finally(() => { dwell = setTimeout(() => { busy = false; current = null; pump() }, FOLLOW_DWELL_MS) })
  }

  const enqueue = (id: string): void => {
    if (id === current || queue.some((q) => q.id === id)) return // merged into the pending move
    queue.push({ id, ts: now() })
    if (queue.length > FOLLOW_QUEUE_MAX) { skipped += queue.length - 1; queue = [queue[queue.length - 1]!] }
  }

  return {
    getView: (): FollowView => view,
    subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb) } },
    /** New acts (any order; only unseen `seq`s count). Pure bookkeeping while OFF, in tab mode, or for another board. */
    feed(entries: readonly ActEntry[]): void {
      const fresh = entries.filter((e) => e.seq > lastSeq).sort((a, b) => a.seq - b.seq)
      if (fresh.length === 0) return
      lastSeq = fresh[fresh.length - 1]!.seq
      if (!on || isTabMode()) return
      const ws = d.workspaceId()
      for (const e of fresh) {
        if (!FOLLOW_VERBS.has(e.verb) || (e.workspaceId && ws && e.workspaceId !== ws)) continue
        enqueue(e.nodeId)
        if (e.nodeId2) enqueue(e.nodeId2)
      }
      pump()
    },
    /** The user touched the canvas: pause, and keep paused while a pointer is held (drag / resize). */
    userMoved(pointer?: 'down' | 'up'): void {
      if (pointer === 'up' && !pointerDown) return // a click outside the canvas is not driving it
      lastUser = now()
      if (pointer) pointerDown = pointer === 'down'
      pump()
    },
    setOn(next: boolean): void {
      on = next
      writeFollowOn(next)
      if (!next) { queue = []; skipped = 0; if (timer) clearTimeout(timer); timer = null }
      pump()
    },
    dispose(): void { if (timer) clearTimeout(timer); if (dwell) clearTimeout(dwell); timer = null; dwell = null; queue = [] },
  }
}

/** Follow for the mounted board: feeds the act record in, and treats real canvas gestures as "the user is driving". */
export function useCentralFollow(rf: RefObject<ReactFlowInstance | null>, entries: readonly ActEntry[], workspaceId: string | null): { view: FollowView; setOn(on: boolean): void } {
  const ws = useRef(workspaceId)
  ws.current = workspaceId
  const [ctl] = useState(() => createFollowController({ getRf: () => rf.current, workspaceId: () => ws.current }))
  useEffect(() => () => ctl.dispose(), [ctl])
  useEffect(() => ctl.feed(entries), [ctl, entries])
  useEffect(() => {
    // Programmatic camera moves (d3 transitions) fire none of these DOM events; user pan/zoom/drag always does
    // (the same distinction as onMoveStart's non-null event in @xyflow/react 12).
    const inCanvas = (e: Event): boolean => e.target instanceof Element && e.target.closest('.react-flow') !== null
    const down = (e: Event): void => { if (inCanvas(e)) ctl.userMoved('down') }
    const up = (): void => ctl.userMoved('up')
    const wheel = (e: Event): void => { if (inCanvas(e)) ctl.userMoved() }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' || (e.target instanceof Element && closestNodeRoot(e.target) !== null)) ctl.userMoved() }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('wheel', wheel, { capture: true, passive: true })
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('wheel', wheel, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [ctl])
  const view = useSyncExternalStore(ctl.subscribe, ctl.getView)
  return { view, setOn: ctl.setOn }
}
