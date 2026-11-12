// What this page saw on each terminal stream: the last output time, the PTY size it asked for and
// the exit. Fed by ws.ts (one Map write per frame); read by the node status bar on its 1s tick, so
// there is no subscription and no re-render per output chunk.
import type { ClientMsg, ServerMsg } from '../shared/protocol'
import type { ExitReason } from './ws'

export interface NodeActivity {
  lastOutputAt?: number
  cols?: number
  rows?: number
  exit?: { code: number; reason?: ExitReason; at: number }
}

const activity = new Map<string, NodeActivity>()

const patch = (id: string, p: Partial<NodeActivity>): void => { activity.set(id, { ...activity.get(id), ...p }) }

/** A message this page sends: `open` starts a new session (the old exit is dropped), `resize` sets the size. */
export function noteClientMsg(msg: ClientMsg): void {
  if (msg.t === 'open') patch(msg.id, { cols: msg.cols, rows: msg.rows, exit: undefined })
  else if (msg.t === 'resize') patch(msg.id, { cols: msg.cols, rows: msg.rows })
}

/** A frame for a subscribed terminal; `reason` is the exit reason as this client sees it. */
export function noteServerMsg(msg: ServerMsg, reason?: ExitReason, now: number = Date.now()): void {
  if (msg.t === 'output') {
    const a = activity.get(msg.id)
    if (a) a.lastOutputAt = now
    else activity.set(msg.id, { lastOutputAt: now })
  } else if (msg.t === 'exit') patch(msg.id, { exit: { code: msg.code, reason, at: now } })
}

export function getActivity(id: string): NodeActivity | undefined { return activity.get(id) }

/** Test reset. */
export function __resetActivityForTests(): void { activity.clear() }
