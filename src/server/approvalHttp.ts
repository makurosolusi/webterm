// HTTP plumbing for the human approval surface: byte-capped body reading, draining on reject, and
// the shared JSON writer. Kept separate from `approvalHumanApi.ts` so the cap can be tested without
// a ledger and so the route file stays inside the line budget.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { firstHeader } from './httpHeaders'

/** Body cap for the human approval family. JSON only; 8 KiB is far above any real request. */
export const APPROVAL_MAX_BODY_BYTES = 8 * 1024

export type BodyRead =
  | { ok: true; raw: string }
  | { ok: false; status: 400 | 413; error: 'invalid_json' | 'payload_too_large' | 'invalid_body' }

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Declared `content-length` above the cap; `undefined` when absent or unparsable. */
export function declaredBytes(headers: NodeJS.Dict<string | string[]>): number | undefined {
  const raw = headers['content-length']
  const value = firstHeader(raw)
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Reads the body counting BYTES (not UTF-16 units) and never buffers past `max`.
 *
 * Two reject paths: an oversized `content-length` is refused before a single chunk is read, and an
 * undeclared/chunked oversize body is drained to `end` first so the client can read the 413 instead
 * of hitting a reset socket. Overflow data is discarded, never accumulated.
 */
export function readCappedBody(
  req: IncomingMessage,
  max: number = APPROVAL_MAX_BODY_BYTES
): Promise<BodyRead> {
  const declared = declaredBytes(req.headers)
  if (declared !== undefined && declared > max) {
    // Drain whatever is still in flight; we never look at it.
    req.resume()
    return Promise.resolve({ ok: false, status: 413, error: 'payload_too_large' })
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    const onData = (chunk: Buffer | string): void => {
      if (overflow) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buf.length
      if (bytes > max) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(buf)
    }
    const onEnd = (): void => {
      req.removeListener('data', onData)
      req.removeListener('error', onError)
      resolve(
        overflow
          ? { ok: false, status: 413, error: 'payload_too_large' }
          : { ok: true, raw: Buffer.concat(chunks).toString('utf8') }
      )
    }
    const onError = (): void => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      resolve({ ok: false, status: 400, error: 'invalid_body' })
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}
