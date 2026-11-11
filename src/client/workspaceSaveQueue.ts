// Serialized, version-aware saves of the active board, with a save state the UI shows. The server
// refuses a save whose base (`updatedAt`) is older than the stored board (409 + current) and a save
// for a deleted board (404); see `Db.save`. Rules:
// - one save in flight at a time, so a debounced save never races the previous one;
// - boards are cumulative, so only the NEWEST payload per board is kept: a payload locked while
//   the previous save was in flight replaces the older unsent one instead of queueing behind it;
// - the base is the newest version the server confirmed to THIS window, not the (possibly older)
//   version the payload was built from;
// - after a 409 every payload built on the stale board is dropped; after a 404 the board is gone;
// - any other failure (offline, 5xx, 413, server restarting) keeps the payload DIRTY: it is
//   retried with backoff, on `retry()` (the Retry button, a socket reconnect) and on the next
//   edit, VS Code "Failed to save … Retry" style.
// - 401/403 = this browser lost its UI session: retrying cannot help, so the automatic retry stops
//   (payload kept dirty), `onAuth` fires once, and only `retry()` / the next edit tries again.
// - a server push (`absorb`, nodes/cables the server added or nodes it removed) is folded into every
//   payload already locked, and when it sits on a version this window knew, its version becomes the next base.
import type { CanvasMsg } from '../shared/protocol'
import type { Workspace } from '../shared/workspace'
import { saveWorkspace } from './api'
import { mergeCanvasPush } from './workspaceCanvasMerge'
import { reconnectDelay } from './ws.connection'

const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
/** Shown instead of the raw HTTP error when the server refused our credential. */
export const SAVE_AUTH_MESSAGE = 'Your sign-in expired. Sign in again; the changes are kept until then.'

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  /** A save failed and is kept dirty; `retryAt` = epoch ms of the next automatic attempt (0 = none:
   *  `auth` means the server refused our credential, so only a manual retry is attempted). */
  | { kind: 'error'; workspaceId: string; message: string; retryAt: number; auth?: true }
  /** The last refused save was dropped because another window changed the board (409). */
  | { kind: 'conflict'; workspaceId: string }

export interface SaveQueueHooks {
  /** Another window saved this board first; `current` is the stored board. */
  onStale: (current: Workspace) => void
  /** The board was deleted (another window); this and every later save for it are dropped. */
  onMissing: (id: string) => void
  /** The server stored `saved` (its answer, with the new version). `superseded` = a newer local
   *  payload for the same board is still queued, so `saved` is already older than the canvas. */
  onSaved?: (saved: Workspace, superseded: boolean) => void
  /** The server answered 401/403: the UI session is gone; fired once per auth stop. */
  onAuth?: () => void
  /** Every save-state transition. */
  onState?: (state: SaveState) => void
}

export interface SaveQueueOptions {
  save?: (ws: Workspace) => Promise<Workspace>
  /** Delay before automatic retry number `attempt` (0-based). */
  retryDelay?: (attempt: number) => number
}

export interface SaveQueue {
  /** Queue a save; resolves once the queue went idle or stopped on a failure. Never rejects. */
  enqueue: (ws: Workspace) => Promise<void>
  /** The server stored `msg.nodes`/`msg.bridges` on this board, or removed `msg.removed` (a canvas push). */
  absorb: (msg: CanvasMsg) => void
  /** Resend the dirty boards now (no-op unless a save failed). */
  retry: () => Promise<void>
  /** True while any board has changes the server has not confirmed. */
  isDirty: () => boolean
  getState: () => SaveState
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Entry = { ws: Workspace; epoch: number }

export function createSaveQueue(hooks: SaveQueueHooks, opts: SaveQueueOptions = {}): SaveQueue {
  const save = opts.save ?? saveWorkspace
  const retryDelay = opts.retryDelay ?? reconnectDelay
  const dirty = new Map<string, Entry>() // newest unconfirmed payload per board
  const confirmed = new Map<string, number>() // board id -> last version the server confirmed (or pushed on top of one)
  const built = new Map<string, number>() // board id -> newest version a payload was built on
  const pushes = new Map<string, { base: number; updatedAt: number }[]>() // pushes not yet chained onto a known version
  let inflight: { id: string; entry: Entry } | null = null
  const epochs = new Map<string, number>() // board id -> bumped on every refused save
  const gone = new Set<string>() // board ids the server answered 404 for
  let running: Promise<void> | null = null
  let failure: { workspaceId: string; message: string; retryAt: number; auth?: true } | null = null
  let conflict: string | null = null
  let attempt = 0 // failed attempts in a row; reset by a confirmed save
  let authStopped = false // a 401/403 was reported and no save has been confirmed since
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let state: SaveState = { kind: 'idle' }

  const emit = (): void => {
    const next: SaveState = failure ? { kind: 'error', ...failure }
      : running || dirty.size ? { kind: 'saving' }
        : conflict ? { kind: 'conflict', workspaceId: conflict } : { kind: 'idle' }
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    hooks.onState?.(state)
  }

  /** Chain pushes onto the newest version this window knows; only then is a push's version a safe base. */
  const advance = (id: string): void => {
    const pending = (pushes.get(id) ?? []).sort((a, b) => a.updatedAt - b.updatedAt)
    let known = Math.max(confirmed.get(id) ?? 0, built.get(id) ?? 0)
    let chained = false
    for (const p of pending) if (p.base <= known && p.updatedAt > known) { known = p.updatedAt; chained = true }
    if (chained) confirmed.set(id, known)
    pushes.set(id, pending.filter((p) => p.updatedAt > known))
  }

  const fail = (id: string, err: unknown): void => {
    // Logged once per failure streak, not once per automatic retry.
    if (attempt === 0) console.error(`[webterm] saving workspace ${id} failed, keeping it unsaved:`, err)
    const delay = retryDelay(attempt++)
    failure = { workspaceId: id, message: errorText(err), retryAt: Date.now() + delay }
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => { retryTimer = null; void retry() }, delay)
  }

  /** Credential refused: no timer (it would loop on 403 forever), the payload stays dirty. */
  const authStop = (id: string): void => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    failure = { workspaceId: id, message: SAVE_AUTH_MESSAGE, retryAt: 0, auth: true }
    if (authStopped) return
    authStopped = true
    console.warn(`[webterm] saving workspace ${id} refused (sign-in required), keeping it unsaved`)
    hooks.onAuth?.()
  }

  /** Send one board; false = stop the pump (the save failed and stays dirty). */
  const send = async (id: string, entry: Entry): Promise<boolean> => {
    const drop = (): void => { if (dirty.get(id) === entry) dirty.delete(id) }
    if (gone.has(id) || (epochs.get(id) ?? 0) !== entry.epoch) { drop(); return true }
    const base = Math.max(entry.ws.updatedAt, confirmed.get(id) ?? 0)
    inflight = { id, entry }
    try {
      const saved = await save({ ...entry.ws, updatedAt: base })
      confirmed.set(id, Math.max(confirmed.get(id) ?? 0, saved.updatedAt))
      advance(id)
      drop()
      conflict = null
      attempt = 0
      authStopped = false
      hooks.onSaved?.(saved, dirty.has(id))
      return true
    } catch (err) {
      const { status, body } = err as { status?: number; body?: { current?: Workspace } }
      // Beaten only by a push this window already absorbed (into `entry` too): resend on its version.
      if (status === HTTP_CONFLICT && body?.current && body.current.updatedAt > base && body.current.updatedAt <= (confirmed.get(id) ?? 0)) return true
      if (status === HTTP_CONFLICT && body?.current) {
        const stored = body.current.updatedAt
        pushes.set(id, (pushes.get(id) ?? []).filter((p) => p.updatedAt > stored))
        epochs.set(id, entry.epoch + 1)
        if (dirty.get(id)?.epoch === entry.epoch) dirty.delete(id) // newer payloads were built on the same stale board
        conflict = id
        hooks.onStale(body.current)
        return true
      }
      if (status === HTTP_NOT_FOUND) {
        gone.add(id)
        dirty.delete(id)
        pushes.delete(id)
        hooks.onMissing(id)
        return true
      }
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) authStop(id)
      else fail(id, err)
      return false
    } finally {
      inflight = null
    }
  }

  const pump = (): Promise<void> => {
    if (running) return running
    const run = (async () => {
      for (;;) {
        const next = dirty.entries().next()
        if (next.done) return
        const [id, entry] = next.value
        if (!(await send(id, entry))) return
      }
    })()
    running = run.finally(() => { running = null; emit() })
    emit()
    return running
  }

  const retry = (): Promise<void> => {
    if (!failure) return running ?? Promise.resolve()
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    failure = null
    return pump()
  }

  return {
    enqueue(ws) {
      if (gone.has(ws.id)) return running ?? Promise.resolve()
      dirty.set(ws.id, { ws, epoch: epochs.get(ws.id) ?? 0 })
      built.set(ws.id, Math.max(built.get(ws.id) ?? 0, ws.updatedAt))
      advance(ws.id)
      // A new edit while a save is failing is a retry too: it carries everything the failed one did.
      return failure && !running ? retry() : pump()
    },
    absorb(msg) {
      const id = msg.workspaceId
      if (gone.has(id)) return
      // Payloads locked before the push lack its nodes and still hold the removed ones; ones built
      // after it already match (or carry a later local delete).
      for (const entry of new Set([dirty.get(id), inflight?.id === id ? inflight.entry : undefined])) {
        if (entry) entry.ws = mergeCanvasPush(entry.ws, msg)
      }
      pushes.set(id, [...(pushes.get(id) ?? []), { base: msg.base, updatedAt: msg.updatedAt }])
      advance(id)
    },
    retry,
    isDirty: () => dirty.size > 0 || running !== null,
    getState: () => state,
  }
}
