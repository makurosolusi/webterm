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
