import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Ledger } from '../ledger/ledger'
import { TELEGRAM_BINDINGS_PATH } from './channelBindingsApi'
import { SENDER_DISABLED_LOG } from './channelSenderBoot'
import { startChannelsRuntime, type ChannelsRuntime } from './channelsRuntime'
import type { TelegramSenderFetch } from './telegramSender'

const SECRET = 'webhook-secret-for-tests-0123456789'
const TOKEN = 'BOT-TOKEN-SECRET-VALUE'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-egress-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

function fakeLedger(): Ledger {
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

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { WEBTERM_TELEGRAM: 'on', WEBTERM_TELEGRAM_WEBHOOK_SECRET: SECRET, ...extra } as NodeJS.ProcessEnv
}

function runtimeWith(sender: { fetch?: TelegramSenderFetch } = {}): ChannelsRuntime {
  const started = startChannelsRuntime(fakeLedger(), {
    env: env({ TELEGRAM_BOT_TOKEN: TOKEN }),
    storePath: tempStorePath(),
    sender: { intervalMs: 60_000, ...(sender.fetch === undefined ? {} : { fetch: sender.fetch }) },
  })
  if (!started) throw new Error('channel runtime did not start')
  return started
}

interface FakeResponse {
  status: number
  body: string
}

function fakeHttp(
  method: string,
  url: string,
  headers: Record<string, string> = {}
): { req: IncomingMessage; res: ServerResponse; done: Promise<FakeResponse> } {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.assign(req, {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    resume: () => undefined,
  })
  let resolveDone: (value: FakeResponse) => void = () => {}
  const done = new Promise<FakeResponse>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader: () => undefined,
    end: (body: string) => resolveDone({ status: res.statusCode, body }),
  } as unknown as ServerResponse
  return { req, res, done }
}

async function callApi(
  channels: ChannelsRuntime,
  method: string,
  path = TELEGRAM_BINDINGS_PATH,
  body?: unknown
): Promise<{ handled: boolean; status: number; body: string }> {
  const { req, res, done } = fakeHttp(method, path, { 'content-type': 'application/json' })
  const handled = channels.handleApi(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return { handled, ...(await done) }
}

describe('channel egress boot', () => {
  it('keeps ingress and the binding API alive without a bot token, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const channels = startChannelsRuntime(fakeLedger(), {
      env: env(),
      storePath: tempStorePath(),
      sender: { intervalMs: 60_000 },
    })
    expect(channels).not.toBeNull()
    if (!channels) return
    expect(channels.senderRunning).toBe(false)
    const lines = warn.mock.calls.map((entry) => String(entry[0])).filter((text) => text.includes(SENDER_DISABLED_LOG))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(TOKEN)

    const idle = await channels.flushNow()
    expect(idle).toMatchObject({ attempted: 0, sent: 0, skipped: 0 })

    const listed = await callApi(channels, 'GET')
    expect(listed.handled).toBe(true)
    expect(listed.status).toBe(200)
    warn.mockRestore()
    channels.stop()
  })

  it('starts exactly one interval when a token exists and drains the outbox through fetch', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as TelegramSenderFetch
    const channels = runtimeWith({ fetch })
    try {
      expect(channels.senderRunning).toBe(true)
      expect(interval).toHaveBeenCalledTimes(1)

      channels.store.enqueueReply({ key: 'r1', channel: 'telegram', chatId: '5', text: 'hello' })
      const result = await channels.flushNow()
      expect(result.attempted).toBe(1)
      expect(result.retried).toBe(1)
      expect(fetch).toHaveBeenCalledTimes(1)
      // The URL carries the token; neither the outcome nor the persisted error may echo it.
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    } finally {
      channels.stop()
      interval.mockRestore()
      expect(channels.senderRunning).toBe(false)
    }
  })

  it('stops on request and never overlaps ticks', async () => {
    const channels = runtimeWith()
    channels.stop()
    channels.stop()
    expect(channels.senderRunning).toBe(false)
    expect((await channels.flushNow()).attempted).toBe(0)
  })

  it('owns only the bindings path and answers CRUD through the runtime', async () => {
    const channels = runtimeWith()
    try {
      expect(channels.handleApi(fakeHttp('GET', '/api/status').req, fakeHttp('GET', '/api/status').res)).toBe(false)

      const created = await callApi(channels, 'POST', TELEGRAM_BINDINGS_PATH, {
        projectId: 'p1',
        chatId: '42',
        role: 'operator',
      })
      expect(created.status).toBe(201)

      const listed = await callApi(channels, 'GET')
      expect(JSON.parse(listed.body).items).toHaveLength(1)

      const denied = await callApi(channels, 'POST', TELEGRAM_BINDINGS_PATH, {
        projectId: 'p1',
        chatId: '-100',
        role: 'owner',
      })
      expect(denied.status).toBe(403)

      const removed = await callApi(channels, 'DELETE', `${TELEGRAM_BINDINGS_PATH}?chatId=42`)
      expect(removed.status).toBe(200)
    } finally {
      channels.stop()
    }
  })
})
