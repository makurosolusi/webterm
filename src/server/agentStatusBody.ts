// Body intake for `POST /api/agent-status`. A hook body past the hard cap is NOT rejected: the
// status/result of a finished turn matters more than its payload, so only a bounded prefix is kept
// and the small fields a status needs are scanned out of it (agentStatusPrefix.ts).
import type { IncomingMessage } from 'node:http'
import type { HookStatusBody } from './hookStatus'
import { scanHookPrefix } from './agentStatusPrefix'

/** Hard cap on the bytes held per hook body; hook JSON is small, 256 KiB is generous without holding a giant payload. */
export const MAX_HOOK_BODY_BYTES = 256 * 1024
/** Part of an oversized body that is scanned for the small status fields. */
export const OVERSIZE_PREFIX_BYTES = 64 * 1024

export type HookBody = HookStatusBody & { transcript_path?: string; last_assistant_message?: unknown }

export interface HookBodyRead {
  body: HookBody
  /** True when the body passed the hard cap; `body` then holds only whitelisted prefix fields. */
  oversize: boolean
  /** Bytes seen so far (a lower bound when `oversize`: the rest is drained unread). */
  bytes: number
}

/** Reads at most MAX_HOOK_BODY_BYTES into memory; on overflow stops listening, drains the rest and returns the scanned prefix. */
export function readHookBody(req: IncomingMessage): Promise<HookBodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let kept = 0
    let total = 0
    let done = false
    const finish = (oversize: boolean): void => {
      if (done) return
      done = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      const raw = Buffer.concat(chunks)
      if (oversize) {
        const prefix = raw.subarray(0, OVERSIZE_PREFIX_BYTES).toString('utf8')
        return resolve({ body: scanHookPrefix(prefix) as HookBody, oversize, bytes: total })
      }
      let body: unknown
      try { body = JSON.parse(raw.toString('utf8')) } catch { body = {} }
      resolve({ body: body && typeof body === 'object' ? (body as HookBody) : {}, oversize, bytes: total })
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      const room = MAX_HOOK_BODY_BYTES - kept
      if (chunk.length <= room) { chunks.push(chunk); kept += chunk.length; return }
      chunks.push(chunk.subarray(0, room))
      req.resume()
      finish(true)
    }
    const onEnd = (): void => finish(false)
    // A broken stream behaves like the old reader: an empty body, so nothing is parsed from it.
    const onError = (): void => { chunks.length = 0; finish(false) }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
