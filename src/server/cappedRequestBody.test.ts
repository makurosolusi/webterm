import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { readCappedRequestBody } from './cappedRequestBody'

function fakeReq(chunks: string[], headers: Record<string, string> = {}) {
  const req = new EventEmitter() as EventEmitter & { headers: Record<string, string>; resumed: boolean; resume(): void }
  req.headers = headers
  req.resumed = false
  req.resume = () => { req.resumed = true }
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', Buffer.from(c))
    req.emit('end')
  })
  return req
}

describe('readCappedRequestBody', () => {
  it('returns the body when within the cap (exactly at the cap)', async () => {
    const r = await readCappedRequestBody(fakeReq(['ab', 'cd']) as unknown as IncomingMessage, 4)
    expect(r).toEqual({ ok: true, body: 'abcd' })
  })
  it('rejects a streamed body one byte over the cap as too_large and drains', async () => {
    const req = fakeReq(['ab', 'cde'])
    expect(await readCappedRequestBody(req as unknown as IncomingMessage, 4)).toEqual({ ok: false, reason: 'too_large' })
    expect(req.resumed).toBe(true)
  })
  it('rejects an oversized declared content-length without reading, and drains', async () => {
    const req = fakeReq([], { 'content-length': '5' })
    expect(await readCappedRequestBody(req as unknown as IncomingMessage, 4)).toEqual({ ok: false, reason: 'too_large' })
    expect(req.resumed).toBe(true)
    expect(req.listenerCount('data')).toBe(0)
  })
  it('maps a stream error to read_failed', async () => {
    const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> }
    req.headers = {}
    queueMicrotask(() => req.emit('error', new Error('reset')))
    expect(await readCappedRequestBody(req as unknown as IncomingMessage, 4)).toEqual({ ok: false, reason: 'read_failed' })
  })
})
