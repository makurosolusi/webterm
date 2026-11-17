// When the human last drove the canvas (pan / zoom / drag / typing in a node). One clock for Follow's pause,
// Central's camera tools (the presence ping tells the server) and the board's own refusal of a polite view frame.
let last = -Infinity
let held = false
const subs = new Set<() => void>()

/** The user touched the canvas; `pointer` keeps it "active" while a button is held (drag / resize). */
export function noteUserActive(pointer?: 'down' | 'up', now: number = Date.now()): void {
  last = now
  if (pointer) held = pointer === 'down'
  for (const s of [...subs]) s()
}

/** Ms since the last gesture (0 while a pointer is held); Infinity when there was none this session. */
export const userIdleMs = (now: number = Date.now()): number => (held ? 0 : now - last)

/** Called on every gesture; returns the unsubscribe. */
export function onUserActive(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** Test seam. */
export function resetUserActivity(): void { last = -Infinity; held = false; subs.clear() }
