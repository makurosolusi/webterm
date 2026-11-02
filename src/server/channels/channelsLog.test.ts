import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '../../shared/logEntry'
import { configureLogging, getLogLevel, logBus, setLogLevel } from '../logs'
import { ChannelStore } from './channelStore'
import { dispatchTelegramUpdate } from './channelDispatch'
import { logEgressFailed, logEgressSent } from './telegramEgressLog'
import { startTelegramPoller } from './telegramPoll'
import { TEST_TOKEN, fakeBotApi, ok } from './telegramPollHarness'

const SECRET_TEXT = 'my-private-message-body'
const CHAT_ID = 987654321
let dir: string
let prevLevel: ReturnType<typeof getLogLevel>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chlog-'))
  prevLevel = getLogLevel()
  setLogLevel('debug')
  configureLogging({ console: false })
  logBus.clear()
})
afterEach(() => {
  setLogLevel(prevLevel)
  configureLogging({ console: true })
  logBus.clear()
  rmSync(dir, { recursive: true, force: true })
})

const events = (): LogEntry[] => logBus.snapshot()
const dump = (): string => JSON.stringify(events())

describe('channels logging', () => {
  it('logs egress ok/fail with a masked chat and never the text or token', () => {
    const fields = { key: `telegram:${CHAT_ID}:7`, chatId: String(CHAT_ID), textLength: 12, attempt: 1, status: 200 }
    logEgressSent(fields, 1)
    logEgressFailed({ ...fields, status: 500 }, 2, `boom https://api.telegram.org/bot${TEST_TOKEN}/sendMessage`, 'dead')
    const [sent, failed] = events()
    expect(sent).toMatchObject({ channel: 'channels.telegram', event: 'telegram.send.ok', level: 'info' })
    expect(failed).toMatchObject({ event: 'telegram.send.fail', level: 'error', data: { outcome: 'dead' } })
    expect(dump()).not.toContain(String(CHAT_ID))
    expect(dump()).not.toContain(TEST_TOKEN)
  })

  it('logs update.recv (type + masked chat) and channel.dispatch without message text', async () => {
    const store = new ChannelStore(join(dir, 'channels.json'))
    const update = { update_id: 5, message: { message_id: 5, text: SECRET_TEXT, chat: { id: CHAT_ID, type: 'private' }, from: { id: 42 } } }
    await dispatchTelegramUpdate(update, { store })
    const names = events().map((e) => e.event)
    expect(names).toEqual(['telegram.update.recv', 'channel.dispatch'])
    expect(events()[0]?.data).toMatchObject({ type: 'message', chat: '***4321', isGroup: false })
    expect(events()[1]?.data).toMatchObject({ status: 'denied', reason: 'unknown_chat' })
    expect(dump()).not.toContain(SECRET_TEXT)
    expect(dump()).not.toContain(String(CHAT_ID))
  })

  it('logs poll start/error/stop and keeps the bot token out of every entry', async () => {
    const api = fakeBotApi([{ status: 401, body: { ok: false, description: `bad ${TEST_TOKEN}` } }])
    const store = new ChannelStore(join(dir, 'channels.json'))
    const poller = startTelegramPoller({
      env: { WEBTERM_TELEGRAM_BOT_TOKEN: TEST_TOKEN } as NodeJS.ProcessEnv,
      cursor: () => store.snapshot().cursor,
      dispatch: async () => ok(true),
      fetch: api.fetch,
    })
    await poller.done
    expect(events().map((e) => e.event)).toEqual(['telegram.poll.start', 'telegram.poll.error', 'telegram.poll.stop'])
    expect(events()[1]).toMatchObject({ level: 'error', data: { kind: 'fatal' } })
    expect(dump()).not.toContain(TEST_TOKEN)
  })
})
