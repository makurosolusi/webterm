import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ChannelStore, ChannelStoreError } from './channelStore'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const V1 = {
  version: 1,
  bindings: { 'telegram:42': { projectId: 'p1', role: 'approver', userId: '7' }, 'telegram:-100': { projectId: 'p1', role: 'owner' } },
  processed: { 'telegram:55': 1_000 },
  cursor: 55,
  outbox: [{ key: 'k', channel: 'telegram', chatId: '42', text: 'hi', createdAt: 1, attempts: 0, state: 'pending' }],
}

function v1File(doc: unknown = V1): string {
  const root = mkdtempSync(join(tmpdir(), 'webterm-channel-mig-'))
  dirs.push(root)
  const path = join(root, 'channels.json')
  writeFileSync(path, JSON.stringify(doc))
  return path
}

describe('channels.json v1 -> v2', () => {
  it('migrates to the default account, backs up the original, and is idempotent', () => {
    const path = v1File()
    const original = readFileSync(path, 'utf8')
    const store = new ChannelStore(path, { now: () => 5_000 })

    expect(store.binding('telegram', '42')).toEqual({ projectId: 'p1', role: 'approver', userId: '7' })
    expect(store.binding('telegram', '-100')?.role).toBe('operator') // group policy still applied
    expect(store.claimUpdate(55)).toBe(false) // dedupe record survived under telegram:default:55
    const snap = store.snapshot()
    expect(snap.version).toBe(2)
    expect(snap.accounts['default']).toMatchObject({ kind: 'telegram', managed: false, state: 'active', createdAt: 5_000 })
    expect(snap.cursor).toBe(55)
    expect(snap.outbox[0]?.nextAt).toBe(1)

    const backup = `${path}.v1.bak`
    expect(readFileSync(backup, 'utf8')).toBe(original)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect((JSON.parse(readFileSync(path, 'utf8')) as { version: number }).version).toBe(2)

    // Second load: already v2, no change, backup untouched.
    const afterFirst = readFileSync(path, 'utf8')
    const again = new ChannelStore(path, { now: () => 9_999 })
    expect(readFileSync(path, 'utf8')).toBe(afterFirst)
    expect(readFileSync(backup, 'utf8')).toBe(original)
    expect(again.snapshot().accounts['default']?.createdAt).toBe(5_000)
  })

  it('keeps accounts apart: the same chat id under another account is unbound', () => {
    const store = new ChannelStore(v1File())
    store.bind('telegram', '42', { projectId: 'p2', role: 'viewer' }, 'bot2')
    expect(store.binding('telegram', '42', 'bot2')?.projectId).toBe('p2')
    expect(store.binding('telegram', '42')?.projectId).toBe('p1')
    expect(store.listBindings('telegram').every((row) => row.binding.projectId === 'p1')).toBe(true)
  })

  it('never overwrites an existing backup with a later file', () => {
    const path = v1File()
    writeFileSync(`${path}.v1.bak`, 'older')
    new ChannelStore(path)
    expect(readFileSync(`${path}.v1.bak`, 'utf8')).toBe('older')
  })

  it('fails closed on a malformed v1 document without writing a backup or touching the file', () => {
    const path = v1File({ ...V1, bindings: 'nope' })
    const before = readFileSync(path, 'utf8')
    expect(() => new ChannelStore(path)).toThrow(ChannelStoreError)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(`${path}.v1.bak`)).toBe(false)
  })
})
