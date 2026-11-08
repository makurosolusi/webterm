// The process-wide CanvasPush over the shared db. Built lazily because bootCa2 runs before the /ws
// server exists; index.ts registers the broadcaster once `wss` is up (frames before that go nowhere).
import type { ServerMsg } from '../../shared/protocol'
import { db } from '../db'
import { createCanvasPush, type CanvasPush } from './canvasPush'

let broadcastFn: (msg: ServerMsg) => void = () => {}
let instance: CanvasPush | null = null

/** Route `t:'canvas'` frames to every open UI socket. */
export function registerCanvasBroadcast(fn: (msg: ServerMsg) => void): void {
  broadcastFn = fn
}

/** The shared instance (never null). */
export function getCanvasPush(): CanvasPush {
  instance ??= createCanvasPush({ db, broadcast: (msg) => broadcastFn(msg) })
  return instance
}
