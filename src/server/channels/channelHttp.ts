// Shared HTTP plumbing for the channel edges (webhook ingress and the human binding API). Both are
// plain node:http handlers that must never buffer an unbounded body, so the byte cap is enforced
// while streaming and a declared `content-length` is only used as an early hint.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { firstHeader } from '../httpHeaders'

export type BodyReadResult = { ok: true; body: string } | { ok: false; reason: 'too_large' | 'read_failed' }

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
  res.end(JSON.stringify(body))
}

export function declaredLength(raw: string | string[] | undefined): number | undefined {
  const value = firstHeader(raw)
  if (value === undefined || !/^\d{1,12}$/.test(value)) return undefined
  return Number(value)
}

/** Read with a hard byte cap. The overflow path drops the listener and drains, so a 413 can be
 *  written without buffering an unbounded body (a declared length is not trusted). */
export function readCappedBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const finish = (result: BodyReadResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > maxBytes) {
        req.resume()
        finish({ ok: false, reason: 'too_large' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') })
    const onError = (): void => finish({ ok: false, reason: 'read_failed' })
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

export interface BodyHeadResult {
  /** Whole body when under the cap; else only its first `headBytes` bytes. Empty after a stream error. */
  text: string
  /** True when the body passed `maxBytes` (the rest is drained unread). */
  truncated: boolean
  /** Bytes seen so far (a lower bound when `truncated`). */
  bytes: number
}

/** Read at most `maxBytes`; past it, stop listening, drain, and keep only the first `headBytes` instead of failing. */
export function readBodyHead(req: IncomingMessage, opts: { maxBytes: number; headBytes: number }): Promise<BodyHeadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let kept = 0
    let total = 0
    let done = false
    const finish = (truncated: boolean): void => {
      if (done) return
      done = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      const raw = Buffer.concat(chunks)
      resolve({ text: (truncated ? raw.subarray(0, opts.headBytes) : raw).toString('utf8'), truncated, bytes: total })
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      const room = opts.maxBytes - kept
      if (chunk.length <= room) { chunks.push(chunk); kept += chunk.length; return }
      chunks.push(chunk.subarray(0, room))
      req.resume()
      finish(true)
    }
    const onEnd = (): void => finish(false)
    // A broken stream yields an empty body, so nothing is parsed from it.
    const onError = (): void => { chunks.length = 0; finish(false) }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
