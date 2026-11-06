// ES-14 pagar final ENVSIMPLE: identifier gerbang lama punah, pagar V4/V6 dan KNOWN_KEYS_FROZEN utuh.
import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CAPABILITY_IDS, DERIVED_FLAGS } from '../shared/featureCapabilities'
import { ENV_REGISTRY, specFor } from './envRegistry'
import { settingsGuard } from './featureCapabilities.guard'

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(SERVER_DIR, '..')
const SELF = 'server/featureCapabilities.final.test.ts'

// Pola disusun dari potongan supaya berkas ini tidak menemukan dirinya sendiri.
const part = (...p: string[]): string => p.join('')
const DEAD_IDENTIFIERS = [part('root', 'Gate'), part('token', '_required'), part('EnvRequires', 'Note'), part('eval', 'Requires')]

const srcFiles = (): string[] =>
  (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .map((f) => f.split('\\').join('/'))
    .filter((f) => /\.tsx?$/.test(f) && f !== SELF)

const CATALOG_KEYS = [
  ...CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey),
  ...CAPABILITY_IDS.flatMap((id) => (CAPABILITIES[id].subs ?? []).map((s) => s.key)),
  ...DERIVED_FLAGS.map((d) => d.key),
]

describe('identifier gerbang lama (D3-REV)', () => {
  it('pemindai melihat banyak berkas src dan mengecualikan dirinya sendiri', () => {
    const files = srcFiles()
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain('server/featureCapabilities.grep.test.ts')
    expect(files).not.toContain(SELF)
  })

  it.each(DEAD_IDENTIFIERS)('%s tidak muncul di berkas src mana pun (termasuk tes lain)', (id) => {
    const hits = srcFiles().filter((f) => readFileSync(join(SRC_DIR, f), 'utf8').includes(id))
    expect(hits).toEqual([])
  })

  it('tak ada berkas Env* tersisa di client (tab Environment sudah dihapus)', () => {
    const leftovers = srcFiles().filter((f) => /^client\/Env[A-Z]/.test(f))
    expect(leftovers).toEqual([])
  })
})

describe('pagar V4/V6 ES-02 tetap ada', () => {
  const guardTest = readFileSync(join(SERVER_DIR, 'featureCapabilities.guard.test.ts'), 'utf8')

  it('berkas tes penjaga masih memuat kasus V4 statis dan header Forwarded', () => {
    expect(guardTest).toContain("describe('statis V4'")
    expect(guardTest).toMatch(/x-forwarded-for/)
    expect(guardTest).toMatch(/forwarded: 'for=/)
    expect(guardTest).toMatch(/reason: 'forwarded'/)
  })

  it('penjaga hidup menolak header Forwarded/X-Forwarded-For walau Origin dan Host sah', () => {
    const mk = (extra: Record<string, string>): IncomingMessage =>
      ({ method: 'POST', headers: { host: '127.0.0.1:8700', origin: 'http://127.0.0.1:8700', ...extra }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage
    expect(settingsGuard(mk({}), undefined)).toMatchObject({ ok: true })
    expect(settingsGuard(mk({ 'x-forwarded-for': '1.2.3.4' }), undefined)).toEqual({ ok: false, reason: 'forwarded' })
    expect(settingsGuard(mk({ forwarded: 'for=1.2.3.4' }), undefined)).toEqual({ ok: false, reason: 'forwarded' })
  })

  it('def tool central tidak mengimpor modul settings/capabilities (V4)', () => {
    const dir = join(SERVER_DIR, 'central/tools/defs')
    const defs = readdirSync(dir).filter((f) => f.endsWith('.def.ts'))
    expect(defs.length).toBeGreaterThan(0)
    const bad = defs.filter((f) => /from\s+['"][^'"]*(envSettings|featureCapabilities)/.test(readFileSync(join(dir, f), 'utf8')))
    expect(bad).toEqual([])
  })
})

describe('KNOWN_KEYS_FROZEN utuh', () => {
  const invariants = readFileSync(join(SERVER_DIR, 'envRegistry.invariants.test.ts'), 'utf8')
  const block = invariants.slice(invariants.indexOf('KNOWN_KEYS_FROZEN: readonly string[] = ['), invariants.indexOf('\n]\n', invariants.indexOf('KNOWN_KEYS_FROZEN: readonly')))
  const frozen = [...block.matchAll(/'((?:WEBTERM|NODETERM)_[A-Z0-9_]+)'/g)].map((m) => m[1] as string)

  it('daftar beku masih dijaga tes invarian dan tak menyusut', () => {
    expect(invariants).toContain('KNOWN_KEYS_FROZEN tetap ter-resolve di registry gabungan')
    expect(frozen.length).toBeGreaterThanOrEqual(40) // test-only: batas bawah saat ES-14 ditulis
    expect(new Set(frozen).size).toBe(frozen.length)
  })

  it('setiap kunci beku dan setiap kunci katalog kemampuan masih dikenal registry', () => {
    expect(frozen.filter((k) => specFor(k) === undefined)).toEqual([])
    expect(CATALOG_KEYS.filter((k) => specFor(k) === undefined)).toEqual([])
    expect(ENV_REGISTRY.length).toBeGreaterThanOrEqual(frozen.length)
  })

  it('kunci primer katalog termasuk daftar beku (override lama tetap terbaca)', () => {
    const primaries = CAPABILITY_IDS.map((id) => CAPABILITIES[id].primaryKey)
    expect(primaries.filter((k) => !frozen.includes(k) && specFor(k)?.key !== k)).toEqual([])
  })
})
