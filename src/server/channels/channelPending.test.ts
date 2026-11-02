import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelStore } from './channelStore'
import { dispatchTelegramUpdate, type ChannelReply } from './channelDispatch'
import { handleChannelBindingsApi } from './channelBindingsHttp'
import { PENDING_CHAT_LIMIT, PENDING_CHAT_TTL_MS, PendingChatStore } from './channelPending'
import { TELEGRAM_PENDING_PATH, handleChannelPendingApi } from './channelPendingHttp'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStore(): ChannelStore {
  const root = mkdtempSync(join(tmpdir(), 'webterm-pending-'))
  dirs.push(root)
  return new ChannelStore(join(root, 'channels', 'channels.json'))
}

function update(id: number, chatId: number, text = 'secret hello', type = 'private') {
  return {
    update_id: id,
    message: {
      message_id: id,
      text,
      chat: { id: chatId, type, first_name: 'Alice', username: 'alice_x' },
      from: { id: chatId, first_name: 'Alice', username: 'alice_x' },
    },
  }
}

describe('PendingChatStore', () => {
  it('upserts per chat id and counts without storing anything else', () => {
    let now = 1000
    const pending = new PendingChatStore({ now: () => now })
    pending.record('42', 'private')
    now = 2000
    pending.record('42', 'private')
    expect(pending.list()).toEqual({
      total: 1,
      items: [{ chatId: '42', type: 'private', firstSeen: 1000, lastSeen: 2000, count: 2 }],
    })
  })

  it('caps entries by dropping the oldest lastSeen', () => {
    let now = 0
    const pending = new PendingChatStore({ now: () => (now += 1), limit: 3 })
    for (const id of ['1', '2', '3']) pending.record(id, 'private')
    pending.record('1', 'private') // refreshed: 2 is now the oldest
    pending.record('4', 'private')
    expect(pending.list().items.map((r) => r.chatId)).toEqual(['4', '1', '3'])
    expect(PENDING_CHAT_LIMIT).toBeGreaterThan(0)
  })

  it('expires entries past the TTL', () => {
    let now = 0
    const pending = new PendingChatStore({ now: () => now })
    pending.record('1', 'private')
    now = PENDING_CHAT_TTL_MS + 1
    expect(pending.list().total).toBe(0)
    pending.record('2', 'private')
    expect(pending.list().items.map((r) => r.chatId)).toEqual(['2'])
  })
})

describe('dispatch records unknown chats', () => {
  it('lists a denied private chat, sends no reply, and stores no message text or name', async () => {
    const store = tempStore()
    const pending = new PendingChatStore()
    const replies: ChannelReply[] = []
    const audit = vi.fn()
    const deps = { store, pending, audit, enqueue: (r: ChannelReply) => void replies.push(r) }

    expect(await dispatchTelegramUpdate(update(1, 42), deps)).toEqual({ status: 'denied', reason: 'unknown_chat' })
    expect(await dispatchTelegramUpdate(update(2, 42), deps)).toEqual({ status: 'denied', reason: 'unknown_chat' })

    expect(replies).toEqual([])
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', reason: 'unknown_chat' }))
    const { items } = pending.list()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ chatId: '42', type: 'private', count: 2 })
    const dump = JSON.stringify(items)
    for (const leaked of ['secret hello', 'Alice', 'alice_x']) expect(dump).not.toContain(leaked)
  })

  it('does not list group chats or already-bound chats', async () => {
    const store = tempStore()
    store.bind('telegram', '7', { projectId: 'p', role: 'viewer' })
    const pending = new PendingChatStore()
    const deps = { store, pending, enqueue: () => undefined }
    await dispatchTelegramUpdate(update(1, -100, 'x', 'group'), deps)
    await dispatchTelegramUpdate(update(2, 7, '/status'), deps)
    expect(pending.list().total).toBe(0)
  })

  it('keeps the same silent denial when recording throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pending = { record: () => { throw new Error('boom') } }
    const out = await dispatchTelegramUpdate(update(1, 42), { store: tempStore(), pending, enqueue: () => undefined })
    expect(out).toEqual({ status: 'denied', reason: 'unknown_chat' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('telegram pending record failed: boom'))
    warn.mockRestore()
  })
})

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  const raw = body === undefined ? '' : JSON.stringify(body)
  Object.assign(req, {
    method,
    url,
    headers: { 'content-type': 'application/json', 'content-length': String(raw.length) },
    resume: () => undefined,
  })
  queueMicrotask(() => {
    if (raw) req.emit('data', Buffer.from(raw))
    req.emit('end')
  })
  return req
}

function call(handler: (req: IncomingMessage, res: ServerResponse) => boolean, method: string, url: string, body?: unknown) {
  return new Promise<{ handled: boolean; status: number; json: any }>((resolve) => {
    const res = {
      headersSent: false,
      statusCode: 0,
      setHeader: () => undefined,
      end: (text: string) => resolve({ handled: true, status: res.statusCode, json: JSON.parse(text) }),
    } as unknown as ServerResponse
    if (!handler(fakeReq(method, url, body), res)) resolve({ handled: false, status: 0, json: null })
  })
}

describe('pending HTTP API', () => {
  it('lists with a limit and dismisses by chat id', async () => {
    const pending = new PendingChatStore()
    for (const id of ['1', '2', '3']) pending.record(id, 'private')
    const h = (req: IncomingMessage, res: ServerResponse) => handleChannelPendingApi(req, res, pending)

    const list = await call(h, 'GET', `${TELEGRAM_PENDING_PATH}?limit=2`)
    expect(list.status).toBe(200)
    expect(list.json.total).toBe(3)
    expect(list.json.items.map((r: { chatId: string }) => r.chatId)).toEqual(['3', '2'])

    expect((await call(h, 'DELETE', `${TELEGRAM_PENDING_PATH}/2`)).status).toBe(200)
    expect((await call(h, 'DELETE', `${TELEGRAM_PENDING_PATH}/2`)).status).toBe(404)
    expect((await call(h, 'DELETE', `${TELEGRAM_PENDING_PATH}/abc`)).json).toEqual({ error: 'invalid_chat_id' })
    expect((await call(h, 'DELETE', `${TELEGRAM_PENDING_PATH}/%E0%A4%A`)).status).toBe(400)
    expect((await call(h, 'POST', TELEGRAM_PENDING_PATH)).status).toBe(405)
    expect((await call(h, 'GET', '/api/channels/telegram/bindings')).handled).toBe(false)
  })

  it('binding a pending chat removes its pending entry', async () => {
    const store = tempStore()
    const pending = new PendingChatStore()
    pending.record('42', 'private')
    pending.record('43', 'private')
    const h = (req: IncomingMessage, res: ServerResponse) =>
      handleChannelBindingsApi(req, res, store, undefined, pending)

    const bad = await call(h, 'POST', '/api/channels/telegram/bindings', { projectId: 'p', chatId: '42', role: 'nope' })
    expect(bad.status).toBe(400)
    expect(pending.list().total).toBe(2)

    const ok = await call(h, 'POST', '/api/channels/telegram/bindings', { projectId: 'p', chatId: 42, role: 'viewer' })
    expect(ok.status).toBe(201)
    expect(pending.list().items.map((r) => r.chatId)).toEqual(['43'])
  })
})
