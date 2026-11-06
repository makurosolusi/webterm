// Serialized, version-aware saves of the active board. The server refuses a save whose base
// (`updatedAt`) is older than the stored board (409 + current) and a save for a deleted board
// (404); see `Db.save`. Two rules keep this window from tripping over its own writes:
// - one save in flight at a time, so a debounced save never races the previous one;
// - the base is the newest version the server confirmed to THIS window, not the (possibly
//   older) version the payload was built from: the boards are cumulative, so a payload locked
//   while the previous save was in flight still contains everything that save carried.
// After a 409 every save already queued for that board was built on the same stale board, so it
// is dropped instead of sent. After a 404 the board is gone: no later save for it is sent either.
import type { Workspace } from '../shared/workspace'
import { saveWorkspace } from './api'

const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409

export interface SaveQueueHooks {
  /** Another window saved this board first; `current` is the stored board. */
  onStale: (current: Workspace) => void
  /** The board was deleted (another window); this and every later save for it are dropped. */
  onMissing: (id: string) => void
}

export interface SaveQueue {
  /** Queue a save; resolves once it (and everything before it) settled. Never rejects. */
  enqueue: (ws: Workspace) => Promise<void>
}

export function createSaveQueue(hooks: SaveQueueHooks, save: (ws: Workspace) => Promise<Workspace> = saveWorkspace): SaveQueue {
  let tail: Promise<void> = Promise.resolve()
  const confirmed = new Map<string, number>() // board id -> last version the server confirmed
  const epochs = new Map<string, number>() // board id -> bumped on every refused save
  const gone = new Set<string>() // board ids the server answered 404 for

  const send = async (ws: Workspace, epoch: number): Promise<void> => {
    if (gone.has(ws.id) || (epochs.get(ws.id) ?? 0) !== epoch) return // deleted, or built on a stale board
    try {
      const saved = await save({ ...ws, updatedAt: Math.max(ws.updatedAt, confirmed.get(ws.id) ?? 0) })
      confirmed.set(ws.id, saved.updatedAt)
    } catch (err) {
      const { status, body } = err as { status?: number; body?: { current?: Workspace } }
      if (status === HTTP_CONFLICT && body?.current) {
        epochs.set(ws.id, epoch + 1)
        hooks.onStale(body.current)
      } else if (status === HTTP_NOT_FOUND) {
        gone.add(ws.id)
        hooks.onMissing(ws.id)
      } else {
        throw err
      }
    }
  }

  return {
    enqueue(ws) {
      const epoch = epochs.get(ws.id) ?? 0
      // The catch keeps the chain alive: one failed save must not block every later one.
      tail = tail.then(() => send(ws, epoch)).catch((err: unknown) => {
        console.error(`[webterm] saving workspace ${ws.id} failed:`, err)
      })
      return tail
    },
  }
}
