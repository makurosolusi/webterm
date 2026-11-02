// test-only: shared helpers for runtime-level tests (fake ledger, temp store, in-memory HTTP call).
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Ledger } from '../ledger/ledger'
import type { ChannelsRuntime } from './channelsRuntime'

const dirs: string[] = []

/** Remove every temp store created by `tempStorePath`; call from afterEach. */
export function cleanTempStores(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-rt-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

export function harnessLedger(): Ledger {
  return {
    approval: {
      listApprovals: () => [],
      getApproval: () => null,
      decideApproval: () => null,
      consumeApproval: () => true,
    },
    event: { appendEvent: () => ({ seq: 1 }) },
  } as unknown as Ledger
}

export interface ApiResult {
  handled: boolean
  status: number
  body: string
}

/** Drive `channels.handleApi` without a socket. A GET/DELETE has no body; pass one for POST. */
export async function callApi(
  channels: ChannelsRuntime,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult> {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method,
    url: path,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    resume: () => undefined,
  })
  let resolveDone: (value: { status: number; body: string }) => void = () => {}
  const done = new Promise<{ status: number; body: string }>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader: () => undefined,
    end: (text: string) => resolveDone({ status: res.statusCode, body: text }),
  } as unknown as ServerResponse
  const handled = channels.handleApi(req, res)
  if (!handled) return { handled, status: 0, body: '' }
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return { handled, ...(await done) }
}
