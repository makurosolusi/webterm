// End-to-end over a local fake Bot API (no real network): poll -> pending -> bind -> reply delivery.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TELEGRAM_BINDINGS_PATH } from './channelBindingsApi'
import { startChannelsRuntime, type ChannelsRuntime } from './channelsRuntime'
import { callApi, cleanTempStores, harnessLedger, tempStorePath } from './channelsRuntimeHarness'
import { resetChannelStatus } from './channelStatus'
import { TELEGRAM_STATUS_PATH } from './channelStatusHttp'
import { TELEGRAM_PENDING_PATH } from './channelPendingHttp'
import { startTelegramInbound } from './telegramPollWiring'
import type { TelegramPoller } from './telegramPoll'

const TOKEN = '987654:AAFakeBotTokenForE2ETests_abcdefg'
const API_BASE_ENV = 'WEBTERM_TELEGRAM_API_BASE'
const IDLE_POLL_MS = 15

interface FakeBotApi {
  url: string
  sent: Array<{ chat_id: string; text: string }>
  updates: unknown[]
  failSend: { description: string } | null
  close(): Promise<void>
}

async function fakeBotApi(): Promise<FakeBotApi> {
  const api: FakeBotApi = { url: '', sent: [], updates: [], failSend: null, close: async () => undefined }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop()
      const params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      const reply = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (method === 'getUpdates') {
        const offset = Number(params['offset'] ?? 0)
        const due = api.updates.filter((u) => (u as { update_id: number }).update_id >= offset)
        setTimeout(() => reply(200, { ok: true, result: due }), due.length ? 0 : IDLE_POLL_MS)
      } else if (method === 'sendMessage' && api.failSend) {
        reply(400, { ok: false, error_code: 400, description: api.failSend.description })
      } else if (method === 'sendMessage') {
        api.sent.push({ chat_id: String(params['chat_id']), text: String(params['text']) })
        reply(200, { ok: true, result: { message_id: api.sent.length } })
      } else {
        reply(200, { ok: true, result: true })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  api.close = () => new Promise((resolve) => server.close(() => resolve()))
  return api
}

const message = (updateId: number, chatId: number, text: string): unknown => ({
  update_id: updateId,
  message: { message_id: updateId, text, chat: { id: chatId, type: 'private' }, from: { id: chatId } },
})

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

let api: FakeBotApi
let channels: ChannelsRuntime
let poller: TelegramPoller | null
let logged: string[]
let previousBase: string | undefined

beforeEach(async () => {
  resetChannelStatus()
  logged = []
  const capture = (...args: unknown[]): void => void logged.push(args.map(String).join(' '))
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(capture)
  api = await fakeBotApi()
  previousBase = process.env[API_BASE_ENV]
  process.env[API_BASE_ENV] = api.url
  const env = {
    WEBTERM_TELEGRAM: 'on',
    WEBTERM_TELEGRAM_MODE: 'poll',
    WEBTERM_TELEGRAM_BOT_TOKEN: TOKEN,
  } as NodeJS.ProcessEnv
  const started = startChannelsRuntime(harnessLedger(), { env, storePath: tempStorePath(), sender: { intervalMs: 60_000 } })
  if (!started) throw new Error('runtime did not start')
  channels = started
  poller = startTelegramInbound({ channels, env })
})

afterEach(async () => {
  await poller?.stop()
  channels.stop()
  await api.close()
  if (previousBase === undefined) delete process.env[API_BASE_ENV]
  else process.env[API_BASE_ENV] = previousBase
  vi.restoreAllMocks()
  cleanTempStores()
})

const getJson = async (path: string): Promise<any> => JSON.parse((await callApi(channels, 'GET', path)).body)

describe('telegram poll end to end (fake Bot API)', () => {
  it('lists an unbound chat as pending, then delivers a reply once it is bound', async () => {
    expect(poller).not.toBeNull()
    api.updates.push(message(1, 555, '/status'))
    await waitFor(async () => (await getJson(TELEGRAM_PENDING_PATH)).total === 1, 'pending chat')
    await channels.flushNow()
    expect(api.sent).toEqual([]) // strangers get no reply
    expect((await getJson(TELEGRAM_PENDING_PATH)).items[0]).toMatchObject({ chatId: '555' })

    const bound = await callApi(channels, 'POST', TELEGRAM_BINDINGS_PATH, { chatId: '555', projectId: 'p1', role: 'viewer' })
    expect(bound.status).toBeLessThan(300)
    expect((await getJson(TELEGRAM_PENDING_PATH)).total).toBe(0)

    api.updates.push(message(2, 555, '/status'))
    // The reply is enqueued after the claim, so drain until it shows up instead of racing it.
    await waitFor(async () => (await channels.flushNow(), api.sent.length > 0), 'reply delivered')
    expect(api.sent).toHaveLength(1)
    expect(api.sent[0]?.chat_id).toBe('555')
    expect((await getJson(TELEGRAM_STATUS_PATH)).egress).toMatchObject({ okCount: 1, errorCount: 0 })
    expect((await getJson(TELEGRAM_STATUS_PATH)).ingress.okCount).toBeGreaterThan(0)
  })

  it('shows a rejected sendMessage in status.egress.lastError without leaking the token', async () => {
    await callApi(channels, 'POST', TELEGRAM_BINDINGS_PATH, { chatId: '556', projectId: 'p1', role: 'viewer' })
    api.failSend = { description: `Bad Request: chat not found (bot${TOKEN})` }
    api.updates.push(message(1, 556, '/status'))
    await waitFor(async () => (await channels.flushNow(), (await getJson(TELEGRAM_STATUS_PATH)).egress.errorCount > 0), 'send failure')

    const status = await getJson(TELEGRAM_STATUS_PATH)
    expect(status.egress.errorCount).toBeGreaterThan(0)
    expect(status.egress.lastError.message).toContain('chat not found')
    const everything = JSON.stringify(status) + logged.join('\n')
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(TOKEN.split(':')[1])
    expect(status).toMatchObject({ mode: 'poll', botTokenSet: true, webhookSecretSet: false })
  })
})
