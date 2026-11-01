import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CHANNEL_STORE_VERSION,
  ChannelStore,
  ChannelStoreError,
} from './channelStore'
import { parseStoreState } from './channelStoreSchema'

const dirs: string[] = []

function tempStorePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-store-'))
  dirs.push(root)
  return join(root, 'channels', 'channels.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ChannelStore persistence', () => {
  it('starts empty, writes 0600 into a 0700 directory, and reloads bindings', () => {
    const path = tempStorePath()
    const store = new ChannelStore(path)
    expect(store.snapshot()).toEqual({
      version: CHANNEL_STORE_VERSION,
      bindings: {},
      processed: {},
      cursor: 0,
      outbox: [],
    })

    store.bind('telegram', '42', { projectId: 'p1', role: 'approver', userId: '7' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)

    const reloaded = new ChannelStore(path)
    expect(reloaded.binding('telegram', '42')).toEqual({ projectId: 'p1', role: 'approver', userId: '7' })
    expect(reloaded.binding('telegram', '99')).toBeUndefined()
    expect(JSON.stringify(reloaded.snapshot())).not.toContain('token')
  })

  it('unbind revokes the conversation durably', () => {
    const path = tempStorePath()
    const store = new ChannelStore(path)
    store.bind('telegram', '42', { projectId: 'p1', role: 'owner' })
    expect(store.unbind('telegram', '42')).toBe(true)
    expect(store.unbind('telegram', '42')).toBe(false)
    expect(new ChannelStore(path).binding('telegram', '42')).toBeUndefined()
  })

  it('claims an update id once across a reload and 100 replays', () => {
    const path = tempStorePath()
    const store = new ChannelStore(path)
    let accepted = 0
    for (let i = 0; i < 100; i += 1) if (store.claimUpdate(55)) accepted += 1
    expect(accepted).toBe(1)
    expect(new ChannelStore(path).claimUpdate(55)).toBe(false)
    expect(store.snapshot().cursor).toBe(55)
  })

  it('releases a claim so a failed effect can be retried', () => {
    const path = tempStorePath()
    const store = new ChannelStore(path)
    expect(store.claimUpdate(9)).toBe(true)
    store.releaseUpdate(9)
    expect(store.claimUpdate(9)).toBe(true)
  })

  it('expires dedupe entries after the TTL', () => {
    const path = tempStorePath()
    let now = 1_000
    const store = new ChannelStore(path, { now: () => now, ttlMs: 500 })
    expect(store.claimUpdate(1)).toBe(true)
    now += 501
    expect(store.claimUpdate(1)).toBe(true)
  })

  it('dedupes outbox replies and reclaims only sent rows when full', () => {
    const path = tempStorePath()
    const store = new ChannelStore(path, { outboxLimit: 2 })
    expect(store.enqueueReply({ key: 'k1', channel: 'telegram', chatId: '1', text: 'a' })).toBe('queued')
    expect(store.enqueueReply({ key: 'k1', channel: 'telegram', chatId: '1', text: 'a' })).toBe('duplicate')
    expect(store.enqueueReply({ key: 'k2', channel: 'telegram', chatId: '1', text: 'b' })).toBe('queued')
    expect(store.enqueueReply({ key: 'k3', channel: 'telegram', chatId: '1', text: 'c' })).toBe('full')
    expect(store.markReplySent('k1')).toBe(true)
    expect(store.enqueueReply({ key: 'k3', channel: 'telegram', chatId: '1', text: 'c' })).toBe('queued')
    expect(store.pendingReplies().map((row) => row.key)).toEqual(['k2', 'k3'])
  })
})

describe('ChannelStore fails closed', () => {
  it('throws on corrupt JSON and never overwrites the file', () => {
    const path = tempStorePath()
    mkdirSync(join(path, '..'), { recursive: true })
    const secret = 'bot123456:SECRET-TOKEN-VALUE'
    const corrupt = `{"version":1,"bindings":{},"processed":{},"cursor":0,"outbox":[]${secret}}`
    writeFileSync(path, corrupt)
    let caught: unknown
    try {
      new ChannelStore(path)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ChannelStoreError)
    expect((caught as ChannelStoreError).code).toBe('corrupt')
    expect(String((caught as Error).message)).not.toContain(secret)
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
  })

  it('throws for an unknown schema version', () => {
    const path = tempStorePath()
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 99, bindings: {}, processed: {}, cursor: 0, outbox: [] }))
    expect(() => new ChannelStore(path)).toThrow(ChannelStoreError)
  })

  it('rejects valid JSON with the wrong shape instead of merging defaults', () => {
    expect(() => parseStoreState(JSON.stringify({ version: 1, bindings: {}, processed: {} }))).toThrow()
    expect(() =>
      parseStoreState(
        JSON.stringify({
          version: 1,
          bindings: { 'telegram:1': { projectId: 'p', role: 'root' } },
          processed: {},
          cursor: 0,
          outbox: [],
        })
      )
    ).toThrow()
  })

  it('does not loosen the file mode on reload', () => {
    const path = tempStorePath()
    const store = new ChannelStore(path)
    store.bind('telegram', '1', { projectId: 'p', role: 'viewer' })
    chmodSync(path, 0o644)
    const reloaded = new ChannelStore(path)
    reloaded.bind('telegram', '2', { projectId: 'p', role: 'viewer' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
