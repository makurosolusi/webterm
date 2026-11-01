import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { ChannelStore } from './channelStore'
import { TELEGRAM_BINDINGS_PATH, type TelegramBindingView } from './channelBindingsApi'
import { BINDINGS_BODY_LIMIT_BYTES, handleChannelBindingsApi } from './channelBindingsHttp'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store(): ChannelStore {
  const root = mkdtempSync(join(tmpdir(), 'webterm-bindings-http-'))
  dirs.push(root)
  return new ChannelStore(join(root, 'channels', 'channels.json'))
}

interface FakeRequestInit {
  method?: string
  url?: string
  headers?: Record<string, string | string[]>
  chunks?: string[]
}

function fakeReq(init: FakeRequestInit = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method: init.method ?? 'GET',
    url: init.url ?? TELEGRAM_BINDINGS_PATH,
    headers: init.headers ?? {},
    socket: { remoteAddress: '127.0.0.1' },
    resume: () => undefined,
  })
  ;(req as unknown as { body: string[] }).body = init.chunks ?? []
  return req
}

function fakeRes(): {
  res: ServerResponse
  done: Promise<{ status: number; body: string; headers: Record<string, string>; ended: boolean }>
} {
  const sent: Record<string, string> = {}
  let resolveDone: (value: { status: number; body: string; headers: Record<string, string>; ended: boolean }) => void =
    () => {}
  const done = new Promise<{ status: number; body: string; headers: Record<string, string>; ended: boolean }>(
    (resolve) => {
      resolveDone = resolve
    }
  )
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      sent[name.toLowerCase()] = value
    },
    end: (body: string) => resolveDone({ status: res.statusCode, body, headers: sent, ended: true }),
  } as unknown as ServerResponse
  return { res, done }
}

const JSON_HEADERS = { 'content-type': 'application/json', 'content-length': '0' }

async function call(
  init: FakeRequestInit = {},
  target: ChannelStore | null = store(),
  audit?: (event: unknown) => void
): Promise<{ handled: boolean; status: number; body: string; headers: Record<string, string>; ended: boolean }> {
  const req = fakeReq(init)
  const { res, done } = fakeRes()
  const handled = handleChannelBindingsApi(req, res, target ?? undefined, audit)
  // The handler attaches body listeners synchronously before its first await.
  for (const chunk of (req as unknown as { body: string[] }).body) req.emit('data', Buffer.from(chunk))
  if (!(req as unknown as { endedSent?: boolean }).endedSent) req.emit('end')
  const response = await Promise.race([
    done,
    new Promise<{ status: number; body: string; headers: Record<string, string>; ended: boolean }>((resolve) =>
      setTimeout(() => resolve({ status: 0, body: '', headers: {}, ended: false }), 100)
    ),
  ])
  return { handled, ...response }
}

function json(body: unknown, headers: Record<string, string> = JSON_HEADERS): FakeRequestInit {
  return { method: 'POST', headers, chunks: [JSON.stringify(body)] }
}

function items(body: string): TelegramBindingView[] {
  return (JSON.parse(body) as { items: TelegramBindingView[] }).items
}

describe('binding API HTTP edge', () => {
  it('answers 503 with no token when the channel is disabled', async () => {
    const token = 'BOT-SECRET-TOKEN-VALUE'
    const previous = process.env.TELEGRAM_BOT_TOKEN
    process.env.TELEGRAM_BOT_TOKEN = token
    try {
      const response = await call({}, null)
      expect(response.handled).toBe(true)
      expect(response.status).toBe(503)
      expect(JSON.parse(response.body)).toEqual({ ok: false, error: 'channel_disabled' })
      expect(response.body).not.toContain(token)
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = previous
    }
  })

  it('owns only the exact path and writes nothing otherwise', () => {
    const req = fakeReq({ url: '/api/status' })
    const { res } = fakeRes()
    expect(handleChannelBindingsApi(req, res, store())).toBe(false)
    expect(res.headersSent).toBe(false)
  })

  it('creates, lists, updates, and deletes a private-chat binding', async () => {
    const bindings = store()
    const created = await call(
      json({ projectId: 'p1', chatId: '42', role: 'approver', userId: '7', token: 'LEAK-ME' }),
      bindings
    )
    expect(created.status).toBe(201)
    const binding = (JSON.parse(created.body) as { binding: TelegramBindingView }).binding
    expect(binding).toEqual({ channel: 'telegram', chatId: '42', projectId: 'p1', role: 'approver', userId: '7' })
    expect(created.body).not.toContain('LEAK-ME')

    const listed = await call({}, bindings)
    expect(listed.status).toBe(200)
    expect(items(listed.body)).toEqual([binding])

    const updated = await call(json({ projectId: 'p2', chatId: 42, role: 'viewer' }), bindings)
    expect(updated.status).toBe(200)
    expect(JSON.parse(updated.body)).toMatchObject({ ok: true, created: false })
    expect(items((await call({}, bindings)).body)[0]).toMatchObject({ projectId: 'p2', role: 'viewer' })

    const removed = await call({ method: 'DELETE', url: `${TELEGRAM_BINDINGS_PATH}?chatId=42` }, bindings)
    expect(removed.status).toBe(200)
    expect(items((await call({}, bindings)).body)).toEqual([])
    expect((await call({ method: 'DELETE', url: `${TELEGRAM_BINDINGS_PATH}?chatId=42` }, bindings)).status).toBe(404)
  })

  it('rejects an approval role on a group chat with 403 and stores nothing', async () => {
    const bindings = store()
    const denied = await call(json({ projectId: 'p1', chatId: '-100', role: 'owner' }), bindings)
    expect(denied.status).toBe(403)
    expect(JSON.parse(denied.body)).toEqual({ error: 'group_approval_role_denied' })
    expect(bindings.listBindings('telegram')).toEqual([])

    const viewer = await call(json({ projectId: 'p1', chatId: '-100', role: 'viewer' }), bindings)
    expect(viewer.status).toBe(201)
  })

  it('is JSON only: wrong content type never reaches the body', async () => {
    const bindings = store()
    const response = await call(json({ projectId: 'p1', chatId: '1', role: 'viewer' }, { 'content-type': 'text/plain' }), bindings)
    expect(response.status).toBe(415)
    expect(bindings.listBindings('telegram')).toEqual([])
  })

  it('caps the body at 8 KiB before parsing, declared and streamed', async () => {
    const bindings = store()
    const oversized = 'x'.repeat(BINDINGS_BODY_LIMIT_BYTES + 1)
    const declared = await call(
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(oversized.length) }, chunks: [oversized] },
      bindings
    )
    expect(declared.status).toBe(413)
    expect(JSON.parse(declared.body)).toEqual({ ok: false, error: 'body_too_large' })

    const streamed = await call(json({ projectId: 'p1', chatId: '1', role: 'viewer', pad: oversized }), bindings)
    expect(streamed.status).toBe(413)
    expect(bindings.listBindings('telegram')).toEqual([])
  })

  it('rejects malformed JSON and unsupported methods without echoing input', async () => {
    const bad = await call({ method: 'POST', headers: JSON_HEADERS, chunks: ['{"projectId":'] })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body)).toEqual({ error: 'invalid_json' })

    const put = await call({ method: 'PUT' })
    expect(put.status).toBe(405)
    expect(put.headers['allow']).toBe('GET, POST, DELETE')
  })
})
