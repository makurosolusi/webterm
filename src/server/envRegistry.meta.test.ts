// Derivasi metadata v2, mapping restart, metadata grup, dan invarian registry (requires, grup).
import { describe, expect, it } from 'vitest'
import { flagIsOn, type EnvRequire } from '../shared/envSettings.contract'
import { ENV_REGISTRY } from './envRegistry'
import { GROUP_META, groupMetaFor, UNKNOWN_GROUP_ORDER } from './envRegistry.groups'
import { resolveMeta } from './envRegistry.meta'
import { enumOf, flag, text } from './envRegistry.types'

const M = { label: 'l', description: 'd' }

describe('resolveMeta', () => {
  it('tanpa metadata: owner/section dari grup, audience advanced, requires kosong', () => {
    expect(resolveMeta(flag('X_A', 'telegram', M))).toMatchObject({ owner: 'channels', section: 'Telegram', audience: 'advanced', requires: [], aliases: [] })
  })

  it('grup asing: owner = section = id grup', () => {
    expect(resolveMeta(flag('X_A', 'zzz', M))).toMatchObject({ owner: 'zzz', section: 'zzz', audience: 'advanced' })
  })

  it('audience user hanya bila dinyatakan; di domain tak terdaftar juga butuh owner eksplisit', () => {
    expect(resolveMeta(flag('X_A', 'central', { ...M, audience: 'user' })).audience).toBe('user')
    expect(resolveMeta(flag('X_A', 'zzz', { ...M, audience: 'user' })).audience).toBe('advanced')
    expect(resolveMeta(flag('X_A', 'zzz', { ...M, audience: 'user', owner: 'files' })).audience).toBe('user')
  })

  it('field eksplisit mengalahkan turunan', () => {
    const m = resolveMeta(flag('X_A', 'central', { ...M, owner: 'o', section: 'S', requires: [{ key: 'K' }], stage: 'preview', aliases: ['OLD'] }))
    expect(m).toMatchObject({ owner: 'o', section: 'S', requires: [{ key: 'K' }], stage: 'preview', aliases: ['OLD'] })
  })
})

describe('restart <-> restartRequired', () => {
  it('default boot (aman), hot:true -> hot, restart eksplisit menang', () => {
    expect(flag('X_A', 'central', M)).toMatchObject({ restart: 'boot', restartRequired: true })
    expect(flag('X_A', 'central', { ...M, hot: true })).toMatchObject({ restart: 'hot', restartRequired: false })
    expect(flag('X_A', 'central', { ...M, restart: 'none' })).toMatchObject({ restart: 'none', restartRequired: false })
    expect(text('X_A', 'central', { ...M, restart: 'boot', hot: true })).toMatchObject({ restart: 'boot', restartRequired: true })
    expect(resolveMeta(flag('X_A', 'central', { ...M, restart: 'none' })).restart).toBe('none')
  })

  it('seluruh registry: restartRequired === (restart === boot) dan resolveMeta konsisten', () => {
    for (const s of ENV_REGISTRY) expect([s.key, s.restartRequired]).toEqual([s.key, resolveMeta(s).restart === 'boot'])
  })
})

describe('metadata grup', () => {
  it('id unik, id sama dengan kunci, order unik; grup asing order 900', () => {
    const metas = Object.entries(GROUP_META)
    expect(metas.every(([k, v]) => k === v.id)).toBe(true)
    expect(new Set(metas.map(([, v]) => v.order)).size).toBe(metas.length)
    expect(groupMetaFor('zzz')).toEqual({ id: 'zzz', label: 'zzz', order: UNKNOWN_GROUP_ORDER, owner: 'zzz' })
    expect(UNKNOWN_GROUP_ORDER).toBeGreaterThan(Math.max(...metas.map(([, v]) => v.order)))
  })

  it('setiap grup yang dipakai registry punya meta core (tak jatuh ke turunan)', () => {
    for (const g of new Set(ENV_REGISTRY.map((s) => s.group))) expect([g, g in GROUP_META]).toEqual([g, true])
  })
})

/** Daftar siklus pada graf `requires` (kunci -> kunci yang disyaratkan). */
function cycles(reg: readonly { key: string; requires?: EnvRequire[] }[]): string[] {
  const edges = new Map(reg.map((s) => [s.key, (s.requires ?? []).map((r) => r.key)]))
  const found: string[] = []
  const visit = (k: string, path: string[]): void => {
    if (path.includes(k)) { found.push([...path, k].join('>')); return }
    for (const n of edges.get(k) ?? []) visit(n, [...path, k])
  }
  for (const k of edges.keys()) visit(k, [])
  return found
}

describe('invarian requires', () => {
  it('helper mendeteksi siklus sintetis', () => {
    expect(cycles([{ key: 'A', requires: [{ key: 'B' }] }, { key: 'B', requires: [{ key: 'A' }] }]).length).toBeGreaterThan(0)
    expect(cycles([{ key: 'A', requires: [{ key: 'B' }] }, { key: 'B' }])).toEqual([])
  })

  it('registry nyata: kunci requires ada di registry dan tak ada siklus', () => {
    const keys = new Set(ENV_REGISTRY.map((s) => s.key))
    const dangling = ENV_REGISTRY.flatMap((s) => (s.requires ?? []).filter((r) => !keys.has(r.key)).map((r) => `${s.key}->${r.key}`))
    expect(dangling).toEqual([])
    expect(cycles(ENV_REGISTRY)).toEqual([])
  })
})

describe('flagIsOn', () => {
  it('trim + case-insensitive, hanya on', () => {
    expect([' ON ', 'on', 'On'].map(flagIsOn)).toEqual([true, true, true])
    expect(['off', '1', 'true', '', undefined].map(flagIsOn)).toEqual([false, false, false, false, false])
  })
})

describe('enum builder tetap kompatibel', () => {
  it('enumOf membawa options + default', () => {
    expect(enumOf('X_E', 'central', ['a', 'b'], 'a', M)).toMatchObject({ kind: 'enum', options: ['a', 'b'], default: 'a' })
  })
})
