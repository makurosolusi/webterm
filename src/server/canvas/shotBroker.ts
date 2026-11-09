// canvas.screenshot broker: the server cannot render the canvas, so it asks every open UI tab (a
// `t:'shot'` frame) and the first tab that uploads to POST /api/canvas-shot/<reqId> answers the
// request. A request nobody answers in time means no webterm window was visible to capture.
// Pending and answered ids live in memory only: a screenshot is never persisted.
import { randomUUID } from 'node:crypto'

/** What the waiting tool call gets: the image (base64) or a short failure code. */
export type ShotResult = { ok: true; mimeType: string; data: string } | { ok: false; code: string }
/** Outcome of an upload: accepted, unknown/expired id, or a tab already answered it. */
export type ShotAnswer = 'ok' | 'unknown' | 'answered'

/** The frame sent to UI sockets; structurally `ShotMsg` of shared/protocol.ts. */
export interface ShotFrame { t: 'shot'; reqId: string; maxWidth: number }

export interface ShotBrokerDeps {
  broadcast(msg: ShotFrame): void | Promise<void>
  now?: () => number
  timeoutMs?: number
  /** Concurrent requests allowed before new ones answer `busy`. */
  maxPending?: number
}

export interface ShotBroker {
  request(maxWidth: number): Promise<ShotResult>
  answer(reqId: string, result: ShotResult): ShotAnswer
}

/** Must outwait the client's capture timeout (canvasShot.ts CAPTURE_TIMEOUT_MS): modern-screenshot can be slow on fonts/images. */
export const SHOT_TIMEOUT_MS = 15_000
/** One screenshot at a time process-wide: a tab can only run one capture, and a second clones the page again. */
const MAX_PENDING = 1
/** Answered ids are remembered this long so a second tab gets 409 instead of 404. */
const ANSWERED_CAP = 64

export function createShotBroker(deps: ShotBrokerDeps): ShotBroker {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? SHOT_TIMEOUT_MS
  const maxPending = deps.maxPending ?? MAX_PENDING
  const pending = new Map<string, (r: ShotResult) => void>()
  const answered = new Map<string, number>()

  const remember = (reqId: string): void => {
    answered.set(reqId, now())
    const cutoff = now() - timeoutMs
    for (const [id, at] of answered) if (answered.size > ANSWERED_CAP || at < cutoff) answered.delete(id)
  }

  return {
    async request(maxWidth) {
      if (pending.size >= maxPending) return { ok: false, code: 'busy' }
      const reqId = randomUUID()
      const done = new Promise<ShotResult>((resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve({ ok: false, code: 'no_visible_window' }) }, timeoutMs)
        pending.set(reqId, (r) => { clearTimeout(timer); pending.delete(reqId); resolve(r) })
      })
      try {
        await deps.broadcast({ t: 'shot', reqId, maxWidth })
      } catch (err) {
        pending.get(reqId)?.({ ok: false, code: 'broadcast_failed' })
        // `code` survives toolExec's handler catch as the audited result code.
        throw Object.assign(new Error(`canvas shot ${reqId}: broadcast failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err }), { code: 'broadcast_failed' })
      }
      return done
    },
    answer(reqId, result) {
      const resolve = pending.get(reqId)
      if (resolve) { remember(reqId); resolve(result); return 'ok' }
      return answered.has(reqId) ? 'answered' : 'unknown'
    },
  }
}

let instance: ShotBroker | null = null

/** The process-wide broker; frames go to every open UI socket (canvasPush.runtime, loaded on first use). */
export function getShotBroker(): ShotBroker {
  instance ??= createShotBroker({ broadcast: async (msg) => (await import('./canvasPush.runtime')).broadcastUi(msg) })
  return instance
}
