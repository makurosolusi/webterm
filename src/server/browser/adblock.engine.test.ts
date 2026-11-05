import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ADBLOCK_CACHE_FILE, ADBLOCK_REFRESH_MS, createAdblock } from './adblock.engine'
import type { AdblockFetch } from './adblock.engine'
import { createShieldPolicy, SHIELDS_FILE } from './adblock.shields'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wt-adblock-')); dirs.push(d); return d }

/** Fake list server (test-only): every filter list returns `rules`; uBO resources are empty. */
function listFetch(rules: string): AdblockFetch & { calls: number } {
  const f = async (url: string) => {
    f.calls++
    const body = url.endsWith('resources.json') ? JSON.stringify({ scriptlets: [], redirects: [] }) : rules
    return { text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer, json: async () => JSON.parse(body) }
  }
  f.calls = 0
  return f
}
const offline: AdblockFetch = async () => { throw new Error('offline (test)') }
const AD = 'https://ads.test/pop.js'
const SITE = 'https://games.test/play'

describe('adblock engine cache', () => {
  it('downloads the lists, blocks matching requests and caches the serialized engine', async () => {
    const dir = tmp()
    const ab = createAdblock({ dir, fetch: listFetch('||ads.test^') })
    expect(ab.check(AD, SITE, 'script')).toEqual({ block: false }) // before load: nothing blocked, never throws
    await ab.load()
    expect(ab.ready()).toBe(true)
    expect(ab.check(AD, SITE, 'script')).toEqual({ block: true })
    expect(ab.check('https://cdn.games.test/app.js', SITE, 'script')).toEqual({ block: false })
    expect(existsSync(join(dir, ADBLOCK_CACHE_FILE))).toBe(true)
  })

  it('a fresh cache is used without any download', async () => {
    const dir = tmp()
    await createAdblock({ dir, fetch: listFetch('||ads.test^') }).load()
    const f = listFetch('||other.test^')
    const ab = createAdblock({ dir, fetch: f })
    await ab.load()
    expect(f.calls).toBe(0)
    expect(ab.check(AD, SITE, 'script').block).toBe(true)
  })

  it('a stale cache is refreshed from the network', async () => {
    const dir = tmp()
    await createAdblock({ dir, fetch: listFetch('||ads.test^') }).load()
    const later = Date.now() + ADBLOCK_REFRESH_MS + 1000
    const ab = createAdblock({ dir, fetch: listFetch('||tracker.test^'), now: () => later })
    await ab.load()
    expect(ab.check('https://tracker.test/t.gif', SITE, 'image').block).toBe(true)
    expect(ab.check(AD, SITE, 'script').block).toBe(false)
    expect(statSync(join(dir, ADBLOCK_CACHE_FILE)).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('offline with a stale cache keeps blocking with the cached lists', async () => {
    const dir = tmp()
    await createAdblock({ dir, fetch: listFetch('||ads.test^') }).load()
    const old = (Date.now() - 2 * ADBLOCK_REFRESH_MS) / 1000
    utimesSync(join(dir, ADBLOCK_CACHE_FILE), old, old)
    const ab = createAdblock({ dir, fetch: offline })
    await ab.load()
    expect(ab.ready()).toBe(true)
    expect(ab.check(AD, SITE, 'script').block).toBe(true)
  })

  it('offline without any cache runs unblocked and does not throw', async () => {
    const ab = createAdblock({ dir: tmp(), fetch: offline })
    await expect(ab.load()).resolves.toBeUndefined()
    expect(ab.ready()).toBe(false)
    expect(ab.check(AD, SITE, 'script')).toEqual({ block: false })
  })
})

describe('per-site shields switch', () => {
  it('persists hosts turned off and reads them back in a new policy', async () => {
    const dir = tmp()
    const ab = createAdblock({ dir, fetch: offline })
    const p = createShieldPolicy(ab, dir)
    expect(p.isOff('games.test')).toBe(false)
    p.setOff('Games.Test', true)
    expect(p.isOff('games.test')).toBe(true)
    expect(existsSync(join(dir, SHIELDS_FILE))).toBe(true)
    const again = createShieldPolicy(ab, dir)
    expect(again.isOff('games.test')).toBe(true)
    again.setOff('games.test', false)
    expect(createShieldPolicy(ab, dir).isOff('games.test')).toBe(false)
  })
})
