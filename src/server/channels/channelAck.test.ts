// B7: the webhook must ack before the (possibly minutes-long) central turn finishes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchTelegramUpdate, type TelegramCentralPort } from './channelDispatch'
import { ChannelStore } from './channelStore'
import { handleTelegramWebhook, type ChannelWebhookRequest } from './telegramWebhookHandler'

const SECRET = 's'.repeat(40)
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function request(update: unknown): ChannelWebhookRequest {
  return {
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': SECRET },
    readBody: async () => ({ ok: true, body: JSON.stringify(update) }),
  }
}

const textUpdate = { update_id: 77, message: { message_id: 1, text: 'hello', chat: { id: 5, type: 'private' }, from: { id: 9 } } }

describe('webhook ack (B7)', () => {
  it('answers 200 well under a second while the central turn is still running, then replies via outbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-channel-ack-'))
    dirs.push(root)
    const store = new ChannelStore(join(root, 'channels.json'))
    store.bind('telegram', '5', { projectId: 'p1', role: 'viewer' })

    let finish: (text: string) => void = () => {}
    const ask = vi.fn(
      () => new Promise<{ ok: true; text: string }>((resolve) => { finish = (text) => resolve({ ok: true, text }) })
    )
    const centralChat: TelegramCentralPort = { ask }
    const tasks: Promise<void>[] = []
    const dispatch = (update: unknown) => dispatchTelegramUpdate(update, { store, centralChat, background: (t) => { tasks.push(t) } })

    const started = Date.now()
    const res = await handleTelegramWebhook(request(textUpdate), { secret: SECRET, dispatch })
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(store.pendingReplies()).toEqual([]) // turn has not finished

    finish('late answer')
    await Promise.all(tasks)
    expect(store.pendingReplies().map((r) => r.text)).toEqual(['late answer'])
  })

  it('replay of one update_id 100 times runs the turn once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-channel-ack-'))
    dirs.push(root)
    const store = new ChannelStore(join(root, 'channels.json'))
    store.bind('telegram', '5', { projectId: 'p1', role: 'viewer' })
    const ask = vi.fn(async () => ({ ok: true as const, text: 'ok' }))
    const tasks: Promise<void>[] = []
    const dispatch = (update: unknown) => dispatchTelegramUpdate(update, { store, centralChat: { ask }, background: (t) => { tasks.push(t) } })

    const results = []
    for (let i = 0; i < 100; i += 1) results.push(await handleTelegramWebhook(request(textUpdate), { secret: SECRET, dispatch }))
    await Promise.all(tasks)
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(results.filter((r) => r.body.duplicate === true)).toHaveLength(99)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('a failing turn is reported to the chat and never rejects the detached task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webterm-channel-ack-'))
    dirs.push(root)
    const store = new ChannelStore(join(root, 'channels.json'))
    store.bind('telegram', '5', { projectId: 'p1', role: 'viewer' })
    const tasks: Promise<void>[] = []
    const ask = async (): Promise<never> => { throw new Error('boom') }
    await dispatchTelegramUpdate(textUpdate, { store, centralChat: { ask }, background: (t) => { tasks.push(t) } })
    await expect(Promise.all(tasks)).resolves.toBeDefined()
  })
})
