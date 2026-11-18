import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDownloadStore } from './browser.downloads.store'
import type { DownloadStore } from './browser.downloads.store'
import type { DownloadEvent } from '../../shared/browser.downloads'

let root: string
let clock: number
const P = 'prof1'
const mk = (o: Partial<Parameters<typeof createDownloadStore>[0]> = {}): DownloadStore => createDownloadStore({ root, now: () => clock, ...o })
const ev = (id: string, name = 'a.bin'): DownloadEvent => ({ k: 'begin', id, nodeId: 'n1', url: 'https://h.example/x', suggestedName: name, now: clock })
/** Play Chromium + the host for one finished download of `bytes` bytes. */
function finish(s: DownloadStore, id: string, name: string, bytes: number): void {
  s.apply(P, ev(id, name))
  writeFileSync(join(s.dir(P), id), Buffer.alloc(bytes))
  s.apply(P, { k: 'progress', id, received: bytes, total: bytes })
  s.apply(P, { k: 'done', id, state: 'completed', name: s.finalize(P, id, name), now: clock })
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wt-dls-')); clock = 1_000 })
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('folder and paths', () => {
  it('creates a 0700 folder per profile and rejects an unsafe profile id', () => {
    const s = mk()
    expect(statSync(s.dir(P)).mode & 0o777).toBe(0o700)
    for (const bad of ['../x', 'a/b', '', '..', 'a\\b']) expect(() => s.dir(bad)).toThrow('invalid profile id')
  })

  it('a path never leaves the profile folder, whatever the item says', () => {
    const s = mk()
    s.apply(P, ev('g1'))
    const item = s.items(P)[0]
    expect(s.pathOf(P, item)).toBe(join(s.dir(P), 'g1'))
    expect(() => s.pathOf(P, { ...item, id: '../g1' })).toThrow('invalid download id')
    expect(() => s.pathOf(P, { ...item, state: 'completed', name: '../../etc/passwd' })).toThrow('escapes')
    expect(() => s.pathOf(P, { ...item, state: 'completed', name: 'a\\b' })).toThrow('escapes')
  })

  it('finalize renames the guid file to a unique safe name with mode 0600', () => {
    const s = mk()
    finish(s, 'g1', 'r.txt', 3)
    finish(s, 'g2', '../r.txt', 3)
    expect(s.items(P).map((i) => i.name)).toEqual(['r.txt', 'r (1).txt'])
    expect(statSync(join(s.dir(P), 'r.txt')).mode & 0o777).toBe(0o600)
    expect(existsSync(join(s.dir(P), 'g1'))).toBe(false)
    expect(() => s.finalize(P, '../g3', 'x')).toThrow('invalid download id')
  })
})

describe('persistence', () => {
  it('reloads from the index: running becomes failed, a vanished file becomes missing, the index is 0600', () => {
    const a = mk()
    finish(a, 'g1', 'keep.txt', 4)
    finish(a, 'g2', 'lost.txt', 4)
    a.apply(P, ev('g3'))
    rmSync(join(a.dir(P), 'lost.txt'))
    expect(statSync(join(a.dir(P), 'index.json')).mode & 0o777).toBe(0o600)
    const b = mk() // a restart: fresh memory, same folder
    expect(b.items(P).map((i) => [i.id, i.state, i.failure])).toEqual([['g1', 'completed', undefined], ['g2', 'missing', undefined], ['g3', 'failed', 'interrupted']])
  })

  it('never trusts a name from the index file', () => {
    const a = mk()
    finish(a, 'g1', 'ok.txt', 1)
    const file = join(a.dir(P), 'index.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('ok.txt', '../../../escape.txt'))
    expect(mk().items(P)[0].name).toBe('escape.txt')
  })

  it('a corrupt index starts empty instead of crashing', () => {
    const a = mk()
    writeFileSync(join(a.dir(P), 'index.json'), '{not json')
    expect(mk().items(P)).toEqual([])
  })
})

describe('quota and expiry', () => {
  it('removes the oldest finished files until the new one fits, and says no when it never will', () => {
    const s = mk({ quota: 100 })
    finish(s, 'g1', 'one.bin', 40)
    finish(s, 'g2', 'two.bin', 40)
    expect(s.used(P)).toBe(80)
    expect(s.makeRoom(P, 50, clock)).toBe(true)
    expect(s.items(P).map((i) => i.id)).toEqual(['g2'])
    expect(existsSync(join(s.dir(P), 'one.bin'))).toBe(false)
    expect(s.makeRoom(P, 101, clock)).toBe(false) // larger than the whole quota
  })

  it('never evicts a file that waits for Keep / Discard or one still running', () => {
    const s = mk({ quota: 100 })
    finish(s, 'g1', 'one.bin', 40)
    s.apply(P, { k: 'pending', id: 'g1', pending: true })
    s.apply(P, ev('run'))
    expect(s.makeRoom(P, 90, clock)).toBe(false)
    expect(s.items(P).map((i) => i.id)).toEqual(['g1', 'run'])
  })

  it('sweep removes entries and files older than the retention', () => {
    const s = mk({ retentionMs: 1000 })
    finish(s, 'old', 'old.bin', 1)
    clock += 5000
    finish(s, 'fresh', 'fresh.bin', 1)
    s.sweep(clock)
    expect(s.items(P).map((i) => i.id)).toEqual(['fresh'])
    expect(existsSync(join(s.dir(P), 'old.bin'))).toBe(false)
    expect(existsSync(join(s.dir(P), 'fresh.bin'))).toBe(true)
  })

  it('history cap removes the file with the entry', () => {
    const s = mk({ max: 2 })
    finish(s, 'g1', 'one.bin', 1)
    finish(s, 'g2', 'two.bin', 1)
    finish(s, 'g3', 'three.bin', 1)
    expect(s.items(P).map((i) => i.id)).toEqual(['g2', 'g3'])
    expect(existsSync(join(s.dir(P), 'one.bin'))).toBe(false)
  })

  it('deleting a canceled item removes its partial files, not another file with its name', () => {
    const s = mk()
    finish(s, 'g1', 'same.bin', 1)
    s.apply(P, ev('g2', 'same.bin'))
    writeFileSync(join(s.dir(P), 'g2'), 'p')
    writeFileSync(join(s.dir(P), 'g2.crdownload'), 'p')
    s.apply(P, { k: 'done', id: 'g2', state: 'canceled', now: clock })
    s.deleteFile(P, s.items(P).find((i) => i.id === 'g2')!)
    expect(existsSync(join(s.dir(P), 'g2'))).toBe(false)
    expect(existsSync(join(s.dir(P), 'g2.crdownload'))).toBe(false)
    expect(existsSync(join(s.dir(P), 'same.bin'))).toBe(true)
  })
})
