// Long Central replies: the dispatcher queues them whole (capped), the sender delivers them as
// several Telegram messages and resumes after the last accepted chunk instead of re-sending it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ChannelStore } from './channelStore'
import {
  CHANNEL_REPLY_CLIPPED_SUFFIX,
  CHANNEL_REPLY_MAX_CHARS,
  dispatchTelegramUpdate,
  type ChannelReply,
} from './channelDispatch'
import { telegramMarkdownChunks } from './telegramSend'
import { TelegramChannelSender, type TelegramSenderFetch } from './telegramSender'

// test-only: fake token, never a real one.
const ENV = () => ({ WEBTERM_TELEGRAM_BOT_TOKEN: '1:TEST' }) as NodeJS.ProcessEnv
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-chunks-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

// ~11k chars of Markdown -> 3+ Telegram messages.
const LONG = Array.from({ length: 300 }, (_, i) => `- **row ${i}** ${'z'.repeat(25)}`).join('\n')

async function centralReply(answer: string): Promise<ChannelReply> {
  const store = new ChannelStore(storePath())
  store.bind('telegram', '100', { projectId: 'p1', role: 'viewer', userId: '7' })
  const replies: ChannelReply[] = []
  const tasks: Promise<void>[] = []
  await dispatchTelegramUpdate(
    { update_id: 5, message: { message_id: 1, chat: { id: 100, type: 'private' }, from: { id: 7 }, text: 'hi' } },
    {
      store,
      centralChat: { ask: async () => ({ ok: true as const, text: answer }) },
      enqueue: (reply) => { replies.push(reply) },
      background: (task) => { tasks.push(task) },
    }
  )
  await Promise.all(tasks)
  expect(replies).toHaveLength(1)
  return replies[0]!
}

describe('central reply length', () => {
  it('queues a reply longer than 4096 chars complete', async () => {
    expect(LONG.length).toBeGreaterThan(4096)
    expect((await centralReply(LONG)).text).toBe(LONG)
  })

  it('caps a runaway reply at CHANNEL_REPLY_MAX_CHARS with a visible suffix', async () => {
    const text = (await centralReply('x'.repeat(CHANNEL_REPLY_MAX_CHARS + 500))).text
    expect(text).toHaveLength(CHANNEL_REPLY_MAX_CHARS)
    expect(text.endsWith(CHANNEL_REPLY_CLIPPED_SUFFIX)).toBe(true)
  })
})

describe('multi-chunk delivery', () => {
  it('resumes after the last accepted chunk; no chunk is sent twice, order kept', async () => {
    const chunks = telegramMarkdownChunks(LONG)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    const path = storePath()
    const store = new ChannelStore(path, { now: () => 0 })
    store.enqueueReply({ key: 'k', channel: 'telegram', chatId: '42', text: LONG })

    const texts: string[] = []
    let calls = 0
    const fetch: TelegramSenderFetch = async (_url, init) => {
      calls += 1
      if (calls === 2) return { ok: false, status: 502, json: async () => ({ ok: false, description: 'Bad Gateway' }) }
      texts.push(String(JSON.parse(init.body).text))
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls } }) }
    }

    const first = new TelegramChannelSender({ store, fetch, env: ENV, now: () => 0, baseDelayMs: 1 })
    expect((await first.flushOnce()).retried).toBe(1)
    expect(texts).toEqual([chunks[0]])
    // Progress survives a restart: a fresh store + sender resumes at chunk 2.
    expect(new ChannelStore(path).pendingReplies()[0]?.chunksDone).toBe(1)

    const second = new TelegramChannelSender({ store: new ChannelStore(path), fetch, env: ENV, now: () => 10_000 })
    expect((await second.flushOnce()).sent).toBe(1)
    expect(texts).toEqual(chunks)
  })

  it('persists chunksDone across a store reload', () => {
    const path = storePath()
    const store = new ChannelStore(path)
    store.enqueueReply({ key: 'k', channel: 'telegram', chatId: '42', text: 'x' })
    store.markReplyFailed('k', { nextAt: 0, chunksDone: 2 })
    expect(new ChannelStore(path).pendingReplies()[0]?.chunksDone).toBe(2)
  })
})
