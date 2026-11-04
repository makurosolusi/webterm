// Deep-link pairing: code rules (Telegram start param), single use + TTL, ingress bind + confirm,
// strangers stay silent, and the POST /pairing route (getMe -> t.me link, workspace name).
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChannelStore } from './channelStore'
import { dispatchTelegramUpdate, type ChannelReply } from './channelDispatch'
import { PendingChatStore } from './channelPending'
import { handleChannelPendingApi } from './channelPendingHttp'
import { PAIRING_CODE_TTL_MS, PairingCodes, START_PARAM_SHAPE, startCodeOf } from './telegramPairing'
import { TELEGRAM_PAIRING_PATH } from './telegramPairingHttp'
import { registerWorkspaceLookup } from '../central/workspaceLookup'

const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijk' // test-only
const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const undo of cleanups.splice(0)) undo()
})

function tempStore(): ChannelStore {
  const root = mkdtempSync(join(tmpdir(), 'webterm-pair-'))
  dirs.push(root)
  return new ChannelStore(join(root, 'channels', 'channels.json'))
}

function update(id: number, chatId: number, text: string, type = 'private') {
  return {
    update_id: id,
    message: { message_id: id, text, chat: { id: chatId, type }, from: { id: chatId, first_name: 'A' } },
  }
}

describe('PairingCodes', () => {
  it('issues random codes that satisfy the Telegram start-parameter rules', () => {
    const codes = new PairingCodes()
    const a = codes.issue({ projectId: 'p', projectName: 'P' }).code
    const b = codes.issue({ projectId: 'p', projectName: 'P' }).code
    expect(a).not.toBe(b)
    expect(a).toMatch(START_PARAM_SHAPE)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(a.length).toBeGreaterThanOrEqual(20)
  })

  it('is single use and expires after the TTL', () => {
    let now = 0
    const codes = new PairingCodes({ now: () => now })
    const one = codes.issue({ projectId: 'p1', projectName: 'One' }).code
    expect(codes.redeem(one)).toEqual({ projectId: 'p1', projectName: 'One' })
    expect(codes.redeem(one)).toBeNull()
    const two = codes.issue({ projectId: 'p2', projectName: 'Two' }).code
    now = PAIRING_CODE_TTL_MS
    expect(codes.redeem(two)).toBeNull()
  })

  it('keeps at most `limit` live codes, dropping the oldest', () => {
    const codes = new PairingCodes({ limit: 2 })
    const [a, b, c] = ['a', 'b', 'c'].map((p) => codes.issue({ projectId: p, projectName: p }).code)
    expect(codes.redeem(a!)).toBeNull()
    expect(codes.redeem(b!)?.projectId).toBe('b')
    expect(codes.redeem(c!)?.projectId).toBe('c')
  })

  it('parses /start <code> only', () => {
    expect(startCodeOf('/start AbC_12-x')).toBe('AbC_12-x')
    expect(startCodeOf('  /start@my_bot AbC  ')).toBe('AbC')
    expect(startCodeOf('/start')).toBeNull()
    expect(startCodeOf('/start a b')).toBeNull()
    expect(startCodeOf('/start bad!code')).toBeNull()
    expect(startCodeOf(`/start ${'x'.repeat(65)}`)).toBeNull()
    expect(startCodeOf('hello /start abc')).toBeNull()
  })
})

describe('dispatch /start <code>', () => {
  it('binds the chat to the code project as owner, confirms, and clears its pending entry', async () => {
    const store = tempStore()
    const pending = new PendingChatStore()
    const replies: ChannelReply[] = []
    const deps = { store, pending, enqueue: (r: ChannelReply) => void replies.push(r) }
    await dispatchTelegramUpdate(update(1, 42, 'hi'), deps) // listed as pending first
    const { code } = pending.pairing.issue({ projectId: 'ws-1', projectName: 'Alpha' })

    const out = await dispatchTelegramUpdate(update(2, 42, `/start ${code}`), deps)
    expect(out).toMatchObject({ status: 'handled', command: 'pair' })
    expect(store.binding('telegram', '42')).toEqual({ projectId: 'ws-1', role: 'owner', userId: '42' })
    expect(replies.map((r) => r.text)).toEqual(['Linked to webterm project "Alpha". Send /status or /inbox to start.'])
    expect(pending.list().total).toBe(0)
  })

  it('a wrong, reused or group code stays a silent denial', async () => {
    const store = tempStore()
    const pending = new PendingChatStore()
    const replies: ChannelReply[] = []
    const deps = { store, pending, enqueue: (r: ChannelReply) => void replies.push(r) }
    const { code } = pending.pairing.issue({ projectId: 'ws-1', projectName: 'Alpha' })

    expect(await dispatchTelegramUpdate(update(1, 7, '/start WRONGCODE'), deps)).toEqual({ status: 'denied', reason: 'unknown_chat' })
    expect(await dispatchTelegramUpdate(update(2, -100, `/start ${code}`, 'group'), deps)).toEqual({ status: 'denied', reason: 'group_not_allowed' })
    await dispatchTelegramUpdate(update(3, 8, `/start ${code}`), deps) // first use wins
    expect(await dispatchTelegramUpdate(update(4, 9, `/start ${code}`), deps)).toEqual({ status: 'denied', reason: 'unknown_chat' })
    expect(store.binding('telegram', '7')).toBeUndefined()
    expect(store.binding('telegram', '-100')).toBeUndefined()
    expect(store.binding('telegram', '9')).toBeUndefined()
    expect(replies.map((r) => r.chatId)).toEqual(['8'])
  })
})

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage
  const raw = body === undefined ? '' : JSON.stringify(body)
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json' }, resume: () => undefined })
  queueMicrotask(() => {
    if (raw) req.emit('data', Buffer.from(raw))
    req.emit('end')
  })
  return req
}

function post(pending: PendingChatStore, deps: Parameters<typeof handleChannelPendingApi>[3], body: unknown, method = 'POST') {
  return new Promise<{ status: number; json: any }>((resolve) => {
    const res = {
      headersSent: false, statusCode: 0, setHeader: () => undefined,
      end: (text: string) => resolve({ status: res.statusCode, json: JSON.parse(text) }),
    } as unknown as ServerResponse
    expect(handleChannelPendingApi(fakeReq(method, TELEGRAM_PAIRING_PATH, body), res, pending, deps)).toBe(true)
  })
}

const getMeOk = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'my_test_bot' } }) }))

describe('POST /api/channels/telegram/pairing', () => {
  it('returns a t.me deep link whose code pairs this project; the token never appears', async () => {
    cleanups.push(registerWorkspaceLookup((id) => (id === 'ws-1' ? { name: 'Alpha' } : null), () => []))
    const pending = new PendingChatStore()
    const r = await post(pending, { env: { WEBTERM_TELEGRAM_BOT_TOKEN: FAKE_TOKEN }, fetch: getMeOk }, { projectId: 'ws-1' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, bot: '@my_test_bot', projectId: 'ws-1', projectName: 'Alpha' })
    const m = /^https:\/\/t\.me\/my_test_bot\?start=([A-Za-z0-9_-]{1,64})$/.exec(r.json.link)
    expect(m).not.toBeNull()
    expect(pending.redeem(m![1]!)).toEqual({ projectId: 'ws-1', projectName: 'Alpha' })
    expect(JSON.stringify(r.json)).not.toContain(FAKE_TOKEN)
  })

  it('maps each failure to a stable error code', async () => {
    cleanups.push(registerWorkspaceLookup((id) => (id === 'ws-1' ? { name: 'Alpha' } : null), () => []))
    const pending = new PendingChatStore()
    const env = { WEBTERM_TELEGRAM_BOT_TOKEN: FAKE_TOKEN }
    expect((await post(pending, { env, fetch: getMeOk }, { projectId: '' })).json.error).toBe('invalid_project_id')
    expect((await post(pending, { env, fetch: getMeOk }, { projectId: 'nope' })).status).toBe(404)
    expect((await post(pending, { env: {}, fetch: getMeOk }, { projectId: 'ws-1' })).json.error).toBe('bot_token_missing')
    const down = vi.fn(async () => { throw new Error('offline') })
    expect((await post(pending, { env, fetch: down }, { projectId: 'ws-1' })).json.error).toBe('unreachable')
    expect((await post(pending, { env, fetch: getMeOk }, undefined, 'GET')).status).toBe(405)
  })
})
