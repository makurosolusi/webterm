// test-only: drives streamProviderTest with a UI request and an in-memory response; resolves the NDJSON lines.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TEST_UI_COOKIE } from '../uiSession.testutil'
import { PROVIDER_TEST_PATH, streamProviderTest, type ProviderTestDeps } from './claudeProvider.connectionStream'
import type { ConnEvent } from './claudeProvider.connectionTest'

/** A UI POST whose body is `body` (JSON-encoded; undefined = empty). */
export const uiPost = (body?: unknown): IncomingMessage =>
  Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method: 'POST', headers: { host: 'localhost:8700', origin: 'http://localhost:8700', 'sec-fetch-site': 'same-origin', cookie: TEST_UI_COOKIE },
  }) as unknown as IncomingMessage

export interface StreamCall { status: number; contentType: string; body: string; events: ConnEvent[]; done: Promise<void>; leave(): void }

/** One POST /api/claude-provider/test; `leave()` drops the connection like a cancelled fetch. */
export function postTest(deps: ProviderTestDeps, req: IncomingMessage = uiPost()): StreamCall {
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>
  const call: StreamCall = { status: 0, contentType: '', body: '', events: [], done: Promise.resolve(), leave: () => { res['writableEnded'] = true; res.emit('close') } }
  let resolve = (): void => undefined
  call.done = new Promise<void>((r) => { resolve = r })
  Object.assign(res, {
    statusCode: 0, writableEnded: false,
    setHeader: (k: string, v: string) => { if (k.toLowerCase() === 'content-type') call.contentType = v },
    flushHeaders: () => undefined,
    write: (chunk: string) => { call.body += chunk; return true },
    end: (chunk?: string) => {
      if (chunk) call.body += chunk
      res['writableEnded'] = true
      call.status = res['statusCode'] as number
      call.events = call.body.split('\n').filter((l) => l !== '' && call.contentType === 'application/x-ndjson').map((l) => JSON.parse(l) as ConnEvent)
      resolve()
      setImmediate(() => res.emit('close'))
    },
  })
  void streamProviderTest(req, res as unknown as ServerResponse, new URL(`http://localhost:8700${PROVIDER_TEST_PATH}`), deps)
  return call
}
