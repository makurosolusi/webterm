import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileSecretStore } from '../envSecrets.store'
import { configureLogging, setLogLevel } from '../logs'
import { logBus } from '../logs/logBus'
import { botSecretKey, createManagedBotRegistry, topicKey } from './botManaged'
import { CENTRAL_BOTS_FLAG, TOPIC_RETRY_MS, createBotManager, mountBotManager } from './botManager'
import { CANARY_TOKEN, fakeTelegram } from './botManager.testutil'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webterm-bots-'))
  configureLogging({ env: { WEBTERM_LOG_FILE: 'off' }, console: false })
  setLogLevel('trace')
  logBus.clear()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ME = { id: 42, is_bot: true, username: 'central_bot' }
function setup(replies: Parameters<typeof fakeTelegram>[0], now = () => 1_000) {
  const tg = fakeTelegram(replies)
  const registryFile = join(dir, 'channels', 'managed-bots.json')
  const manager = createBotManager({
    secrets: createFileSecretStore(join(dir, 'secrets')),
    registry: createManagedBotRegistry(registryFile),
    fetch: tg.fetch,
    now,
  })
  return { ...tg, manager, registryFile }
}
const everywhere = (): string => {
  const files = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)])) : [])
  return files(dir).filter((f) => !f.includes(`${join(dir, 'secrets')}`)).map((f) => readFileSync(f, 'utf8')).join('\n') + JSON.stringify(logBus.query())
}

describe('propose', () => {
  it('verifies with getMe, stores the token only in the secret file, returns username and length', async () => {
    const { manager, calls } = setup({ getMe: { result: ME } })
    const out = await manager.propose({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: 'ops alerts' })
    expect(out).toEqual({ ok: true, bot: { accountId: 'ops', botId: 42, username: 'central_bot', tokenLength: CANARY_TOKEN.length } })
    expect(JSON.stringify(out)).not.toContain(CANARY_TOKEN)
    expect(calls.map((c) => c.method)).toEqual(['getMe'])
    const secretFile = join(dir, 'secrets', botSecretKey('ops'))
    expect(readFileSync(secretFile, 'utf8')).toBe(CANARY_TOKEN)
    expect(statSync(secretFile).mode & 0o077).toBe(0)
    expect(manager.registry.get('ops')).toMatchObject({ username: 'central_bot', state: 'active', purpose: 'ops alerts' })
    expect(everywhere()).not.toContain(CANARY_TOKEN)
  })

  it('getMe failure stores nothing and leaks nothing (error text echoing the token is scrubbed)', async () => {
    const { manager } = setup({ getMe: { status: 401, description: `Unauthorized ${CANARY_TOKEN}` } })
    const out = await manager.propose({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: 'x' })
    expect(out).toEqual({ ok: false, code: 'getme_failed' })
    expect(existsSync(join(dir, 'secrets', botSecretKey('ops')))).toBe(false)
    expect(manager.registry.get('ops')).toBeUndefined()
    expect(everywhere()).not.toContain(CANARY_TOKEN)
    expect(logBus.query().some((e) => e.event === 'bots.getme_failed')).toBe(true)
  })

  it('rejects a malformed token before any network call, a non-bot, and a second active registration', async () => {
    const { manager, calls } = setup({ getMe: { result: { id: 1, is_bot: false, username: 'human' } } })
    expect(await manager.propose({ accountId: 'ops', botToken: 'short', purpose: 'x' })).toEqual({ ok: false, code: 'invalid_token' })
    expect(await manager.propose({ accountId: 'Bad Id', botToken: CANARY_TOKEN, purpose: 'x' })).toEqual({ ok: false, code: 'invalid_token' })
    expect(calls).toHaveLength(0)
    expect(await manager.propose({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: 'x' })).toEqual({ ok: false, code: 'not_a_bot' })
    const ok = setup({ getMe: { result: ME } })
    await ok.manager.propose({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: 'x' })
    expect(await ok.manager.propose({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: 'x' })).toEqual({ ok: false, code: 'conflict' })
  })
})

describe('topics', () => {
  const input = { accountId: 'ops', chatId: '-1001', projectId: 'p1', projectName: 'Alpha' }
  async function registered(replies: Parameters<typeof fakeTelegram>[0], clock = { t: 1_000 }) {
    const s = setup({ getMe: { result: ME }, ...replies }, () => clock.t)
    await s.manager.propose({ accountId: 'ops', botToken: CANARY_TOKEN, purpose: 'x' })
    return { ...s, clock }
  }

  it('creates one topic per project, persists the mapping and reuses it', async () => {
    const { manager, calls, registryFile } = await registered({ createForumTopic: { result: { message_thread_id: 77 } } })
    expect(await manager.topicFor(input)).toEqual({ threadId: 77, fallback: false })
    expect(await manager.topicFor(input)).toEqual({ threadId: 77, fallback: false })
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1)
    expect(calls.find((c) => c.method === 'createForumTopic')?.body).toEqual({ chat_id: '-1001', name: 'Alpha' })
    expect(JSON.parse(readFileSync(registryFile, 'utf8'))[0].topics[topicKey('-1001', 'p1')]).toBe(77)
    // a second project gets its own topic
    expect((await manager.topicFor({ ...input, projectId: 'p2', projectName: 'Beta' })).fallback).toBe(false)
  })

  it('falls back without a topic when the group is not a forum, logs it, and retries only after the backoff', async () => {
    const { manager, calls, clock } = await registered({ createForumTopic: { status: 400, description: 'Bad Request: the chat is not a forum' } })
    expect(await manager.topicFor(input)).toEqual({ fallback: true })
    expect(await manager.topicFor(input)).toEqual({ fallback: true })
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1)
    expect(logBus.query().filter((e) => e.event === 'bots.topic_fallback')).toHaveLength(1)
    clock.t += TOPIC_RETRY_MS + 1
    await manager.topicFor(input)
    expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(2)
    expect(everywhere()).not.toContain(CANARY_TOKEN)
  })

  it('an unknown or revoked account falls back instead of throwing', async () => {
    const { manager } = setup({})
    expect(await manager.topicFor(input)).toEqual({ fallback: true })
  })
})

describe('mount', () => {
  it('flag off builds nothing and touches no files; flag on builds a manager', () => {
    expect(mountBotManager({}, dir)).toBeNull()
    expect(mountBotManager({ [CENTRAL_BOTS_FLAG]: 'off' }, dir)).toBeNull()
    expect(readdirSync(dir)).toEqual([])
    expect(mountBotManager({ [CENTRAL_BOTS_FLAG]: 'on' }, dir)?.registry.list()).toEqual([])
  })
})
