import { describe, expect, it } from 'vitest'

import { DedupeStore, dedupeKey } from './dedupe'
import {
  IdentityRegistry,
  authorizeCommand,
  isBareConsent,
  parseCommand,
  type ChannelCommand,
  type ChannelMessageIdentity,
  type ChannelRole,
} from './identity'
import { Outbox } from './outbox'
import { TELEGRAM_TOKEN_ENV, parseTelegramUpdate, sendTelegramMessage, type TelegramFetch } from './telegram'

function okResponse(messageId = 1) {
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: messageId } }) }
}

function fixedClock(start = 1_000) {
  let current = start
  return { now: () => current, advance: (ms: number) => { current += ms } }
}

const msg = (chatId: string, userId: string, isGroup = false): ChannelMessageIdentity => ({
  channel: 'telegram',
  chatId,
  userId,
  isGroup,
})

describe('telegram update normalization', () => {
  const groupUpdate = {
    update_id: 42,
    message: {
      message_id: 7,
      message_thread_id: 3,
      text: '/status',
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 555 },
    },
  }

  it('normalizes a group message', () => {
    expect(parseTelegramUpdate(groupUpdate)).toEqual({
      updateId: 42,
      chatId: '-100123',
      userId: '555',
      text: '/status',
      isGroup: true,
      messageId: 7,
      threadId: 3,
    })
  })

  it('treats a private chat as a non-group and defaults text to empty', () => {
    const normalized = parseTelegramUpdate({
      update_id: 1,
      message: { chat: { id: 9, type: 'private' }, from: { id: 9 }, photo: [] },
    })
    expect(normalized).toMatchObject({ chatId: '9', userId: '9', text: '', isGroup: false })
  })

  it('returns null for updates without a usable message', () => {
    expect(parseTelegramUpdate({ message: groupUpdate.message })).toBeNull()
    expect(parseTelegramUpdate({ update_id: 5, callback_query: { id: 'x' } })).toBeNull()
    expect(parseTelegramUpdate({ update_id: -1 })).toBeNull()
  })
})

describe('telegram send', () => {
  it('sends with the injected fetch and keeps the token out of the result', async () => {
    const calls: string[] = []
    const fake: TelegramFetch = async (url) => {
      calls.push(url)
      return okResponse(9)
    }
    const result = await sendTelegramMessage(
      { chatId: '1', text: 'hello' },
      { token: '123:secret-token-value', fetch: fake }
    )
    expect(result).toEqual({ ok: true, messageId: 9 })
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('secret-token-value')
  })

  it('reads the token from env at call time and fails typed when unset', async () => {
    const previous = process.env[TELEGRAM_TOKEN_ENV]
    try {
      delete process.env[TELEGRAM_TOKEN_ENV]
      const noToken = await sendTelegramMessage({ chatId: '1', text: 'x' }, { fetch: async () => okResponse() })
      expect(noToken).toEqual({ ok: false, status: 0, error: 'bot_token_not_configured' })

      process.env[TELEGRAM_TOKEN_ENV] = 'env-token-123456'
      let seen = ''
      const fake: TelegramFetch = async (url) => {
        seen = url
        return okResponse(2)
      }
      expect(await sendTelegramMessage({ chatId: '1', text: 'x' }, { fetch: fake })).toEqual({ ok: true, messageId: 2 })
      expect(seen).toContain('env-token-123456')
    } finally {
      if (previous === undefined) delete process.env[TELEGRAM_TOKEN_ENV]
      else process.env[TELEGRAM_TOKEN_ENV] = previous
    }
  })

  it('surfaces retry_after and redacts the token from provider errors', async () => {
    const limited: TelegramFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }),
    })
    const limitedResult = await sendTelegramMessage({ chatId: '1', text: 'x' }, { token: 'tok-123456', fetch: limited })
    expect(limitedResult).toEqual({ ok: false, status: 429, error: 'Too Many Requests', retryAfterMs: 7000 })
    const broken: TelegramFetch = async () => {
      throw new Error('connect failed https://api.telegram.org/botSECRET-TOKEN-XYZ/sendMessage')
    }
    const result = await sendTelegramMessage({ chatId: '1', text: 'x' }, { token: 'SECRET-TOKEN-XYZ', fetch: broken })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('SECRET-TOKEN-XYZ')
      expect(result.error).toContain('[redacted]')
    }
  })
})

describe('DedupeStore', () => {
  it('runs one effect across 100 replays and returns the stored result', async () => {
    const store = new DedupeStore()
    let effects = 0
    for (let i = 0; i < 100; i += 1) {
      const result = await store.once(dedupeKey('telegram', 42), () => {
        effects += 1
        return { ack: 200 }
      })
      expect(result).toEqual({ duplicate: i > 0, value: { ack: 200 } })
    }
    expect(effects).toBe(1)
  })

  it('shares one in-flight effect between concurrent deliveries', async () => {
    const store = new DedupeStore()
    let effects = 0
    const effect = async () => {
      effects += 1
      await Promise.resolve()
      return 'done'
    }
    const results = await Promise.all(Array.from({ length: 10 }, () => store.once('k', effect)))
    expect(effects).toBe(1)
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1)
    expect(results.every((r) => r.value === 'done')).toBe(true)
  })

  it('expires claims after the TTL and never claims twice while held', async () => {
    const clock = fixedClock()
    const store = new DedupeStore({ ttlMs: 1_000, now: clock.now })
    expect(store.claim('a')).toBe(true)
    expect(store.claim('a')).toBe(false)
    await store.once('b', () => 1)
    clock.advance(1_001)
    expect(store.has('b')).toBe(false)
    expect(await store.once('b', () => 2)).toEqual({ duplicate: false, value: 2 })
  })
})

describe('identity and authorization', () => {
  const registry = new IdentityRegistry()
  registry.bind('telegram', '100', { projectId: 'p1', role: 'approver', userId: '7' })
  registry.bind('telegram', '-100', { projectId: 'p1', role: 'viewer' })
  const approve: ChannelCommand = { kind: 'approve', approvalId: 'a', digest: 'd', nonce: 'n' }

  it('rejects an unknown chat instead of auto-enrolling', () => {
    expect(authorizeCommand(msg('999', '7'), approve, registry)).toEqual({ ok: false, reason: 'unknown_chat' })
  })

  it('denies approval from a bound group even with an approver binding', () => {
    registry.bind('telegram', '-200', { projectId: 'p1', role: 'owner', userId: '7' })
    expect(authorizeCommand(msg('-200', '7', true), approve, registry)).toEqual({ ok: false, reason: 'group_not_allowed' })
  })

  it('allows a bound approver to approve in a private chat only', () => {
    const expected = { ok: true, binding: { projectId: 'p1', role: 'approver', userId: '7' } }
    expect(authorizeCommand(msg('100', '7'), approve, registry)).toEqual(expected)
    expect(registry.unbind('telegram', '100')).toBe(true)
    expect(registry.resolve('telegram', '100')).toBeUndefined()
    registry.bind('telegram', '100', { projectId: 'p1', role: 'approver', userId: '7' })
  })

  it('denies a different user, a non-approver role, and lets groups read status', () => {
    expect(authorizeCommand(msg('100', '8'), approve, registry)).toEqual({ ok: false, reason: 'user_mismatch' })
    registry.bind('telegram', '300', { projectId: 'p1', role: 'viewer', userId: '7' })
    expect(authorizeCommand(msg('300', '7'), approve, registry)).toEqual({ ok: false, reason: 'role_denied' })
    expect(authorizeCommand(msg('-100', '5', true), { kind: 'status' }, registry).ok).toBe(true)
  })

  it('rejects invalid bindings', () => {
    expect(() => registry.bind('telegram', 'x', { projectId: 'p', role: 'root' as ChannelRole })).toThrow()
  })
})

describe('command grammar', () => {
  it('parses the deterministic command set', () => {
    expect(parseCommand('/status')).toEqual({ ok: true, command: { kind: 'status' } })
    expect(parseCommand('/status@WebtermBot proj')).toEqual({ ok: true, command: { kind: 'status', project: 'proj' } })
    expect(parseCommand('/inbox')).toEqual({ ok: true, command: { kind: 'inbox' } })
    expect(parseCommand('/task t-1')).toEqual({ ok: true, command: { kind: 'task', taskId: 't-1' } })
    expect(parseCommand('/approve a1 sha256abc nonce1')).toEqual({
      ok: true,
      command: { kind: 'approve', approvalId: 'a1', digest: 'sha256abc', nonce: 'nonce1' },
    })
    expect(parseCommand('/reject a1 wrong target')).toEqual({
      ok: true,
      command: { kind: 'reject', approvalId: 'a1', reason: 'wrong target' },
    })
    expect(parseCommand('/pause')).toEqual({ ok: true, command: { kind: 'pause' } })
    expect(parseCommand('/resume p1')).toEqual({ ok: true, command: { kind: 'resume', project: 'p1' } })
  })

  it('never treats free text or bare "yes" as consent', () => {
    expect(parseCommand('yes')).toMatchObject({ ok: false, code: 'not_a_command' })
    expect(parseCommand('ok!')).toMatchObject({ ok: false, code: 'not_a_command' })
    expect(parseCommand('deploy it')).toMatchObject({ ok: false, code: 'not_a_command' })
    expect(isBareConsent('Yes')).toBe(true)
    expect(isBareConsent('/approve a b c')).toBe(false)
  })

  it('returns usage errors for malformed or unknown commands', () => {
    expect(parseCommand('')).toMatchObject({ ok: false, code: 'empty' })
    expect(parseCommand('/approve a1 digest')).toMatchObject({ ok: false, code: 'usage' })
    expect(parseCommand('/status a b')).toMatchObject({ ok: false, code: 'usage' })
    expect(parseCommand('/exec rm -rf /')).toMatchObject({ ok: false, code: 'unknown_command' })
    expect(parseCommand(`/${'x'.repeat(513)}`)).toMatchObject({ ok: false, code: 'too_long' })
  })
})

describe('Outbox', () => {
  it('enqueues once per idempotency key and marks success', async () => {
    const clock = fixedClock()
    const outbox = new Outbox({ now: clock.now })
    expect(outbox.enqueue('msg-1', 'telegram', { text: 'hi' })).toBe('queued')
    expect(outbox.enqueue('msg-1', 'telegram', { text: 'hi again' })).toBe('duplicate')
    expect(outbox.due()).toHaveLength(1)
    expect(await outbox.dispatch('msg-1', async () => {})).toBe('sent')
    expect(outbox.due()).toHaveLength(0)
    expect(outbox.get('msg-1')?.state).toBe('sent')
  })

  it('backs off without throwing and retries only after the delay', async () => {
    const clock = fixedClock()
    const outbox = new Outbox({ now: clock.now, baseDelayMs: 1_000, maxDelayMs: 8_000 })
    outbox.enqueue('msg-2', 'telegram', { text: 'hi' })
    let sends = 0
    const down = async () => {
      sends += 1
      throw new Error('channel down')
    }
    await expect(outbox.dispatch('msg-2', down)).resolves.toBe('retry')
    expect(sends).toBe(1)
    expect(outbox.get('msg-2')).toMatchObject({ attempts: 1, state: 'pending', nextAt: 2_000 })
    expect(await outbox.dispatch('msg-2', down)).toBe('retry')
    expect(sends).toBe(1)
    clock.advance(1_000)
    expect(outbox.due()).toHaveLength(1)
    await expect(outbox.dispatch('msg-2', down)).resolves.toBe('retry')
    expect(outbox.get('msg-2')?.nextAt).toBe(4_000)
    expect(sends).toBe(2)
  })

  it('moves an exhausted entry to the dead-letter queue and can replay it', async () => {
    const clock = fixedClock()
    const outbox = new Outbox({ now: clock.now, maxAttempts: 2, baseDelayMs: 100 })
    outbox.enqueue('msg-3', 'telegram', { text: 'hi' })
    const down = async () => {
      throw new Error('still down')
    }
    expect(await outbox.dispatch('msg-3', down)).toBe('retry')
    clock.advance(100)
    expect(await outbox.dispatch('msg-3', down)).toBe('dead')
    expect(await outbox.dispatch('msg-3', down)).toBe('dead')
    expect(outbox.deadLetters().map((entry) => entry.key)).toEqual(['msg-3'])
    expect(outbox.retryDead('msg-3')).toBe(true)
    expect(outbox.retryDead('msg-3')).toBe(false)
    expect(await outbox.dispatch('msg-3', async () => {})).toBe('sent')
    expect(outbox.stats()).toEqual({ pending: 0, sent: 1, dead: 0, attempts: 0 })
  })

  it('never serializes a secret in payloads or error text', async () => {
    const outbox = new Outbox()
    outbox.enqueue('msg-4', 'telegram', { text: 'safe' })
    const leaky = async () => {
      throw new Error('send failed bot123456:ABCDEFGHIJKLMNOP')
    }
    expect(await outbox.dispatch('msg-4', leaky)).toBe('retry')
    const serialized = JSON.stringify(outbox.snapshot())
    expect(serialized).not.toContain('ABCDEFGHIJKLMNOP')
    expect(serialized).toContain('[redacted]')
  })
})
