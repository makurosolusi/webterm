// The process-wide CanvasPush over the shared db. Built lazily because bootCa2 runs before the /ws
// server exists; index.ts registers the broadcaster once `wss` is up (frames before that go nowhere)
// and the teardown that ends a removed node's sessions/page (kept out of here so this module does
// not pull the PTY and browser runtimes into everything that imports it).
import type { ServerMsg } from '../../shared/protocol'
import { db } from '../db'
import { createCanvasPush, type CanvasNode, type CanvasPush } from './canvasPush'

let broadcastFn: (msg: ServerMsg) => void = () => {}
let teardownFn: (nodes: CanvasNode[]) => void = () => {}
let instance: CanvasPush | null = null

/** Route `t:'canvas'` frames to every open UI socket. */
export function registerCanvasBroadcast(fn: (msg: ServerMsg) => void): void {
  broadcastFn = fn
}

/** End what removed nodes still run (PTY sessions of every pane, browser pages). */
export function registerCanvasTeardown(fn: (nodes: CanvasNode[]) => void): void {
  teardownFn = fn
}

/** The shared instance (never null). */
export function getCanvasPush(): CanvasPush {
  instance ??= createCanvasPush({ db, broadcast: (msg) => broadcastFn(msg), teardown: (nodes) => teardownFn(nodes) })
  return instance
}
