// Turunan murni baris env: evaluasi requires (draft menimpa state, kunci tak dikenal), isChanged, needsRestart.
import { describe, expect, it } from 'vitest'
import { evalRequires, type EnvEntryV2 } from '../shared/envSettings.contract'
import { activeDiffers, isChanged, needsRestart, requiredValueText, unmetRequires } from './envRequires'

const mk = (e: Partial<EnvEntryV2> = {}): EnvEntryV2 => ({
  key: 'K', kind: 'flag', group: 'g', label: 'L', description: 'd', value: 'off', default: 'off', source: 'default',
  restartRequired: false, pendingRestart: false, dangerous: false, editable: true, owner: 'o', section: 's',
  audience: 'user', requires: [], restart: 'none', effective: 'off', valid: true, ...e,
})
const server: Record<string, string> = { A: 'on', B: 'off', M: 'poll' }
const get = (draft: Record<string, string> = {}) => (k: string) => draft[k] ?? server[k]

describe('requires', () => {
  const e = mk({ requires: [{ key: 'A' }, { key: 'B' }, { key: 'M', oneOf: ['poll', 'webhook'] }, { key: 'ZZ' }] })

  it('tabel kebenaran: on/off/oneOf/tak dikenal', () => {
    expect(evalRequires(e, get()).map((r) => r.met)).toEqual([true, false, true, 'unknown'])
  })

  it('draft menimpa state server', () => {
    expect(evalRequires(e, get({ A: 'off', B: 'ON', M: 'x' })).map((r) => r.met)).toEqual([false, true, false, 'unknown'])
  })

  it('unmetRequires hanya yang pasti belum terpenuhi (unknown bukan peringatan)', () => {
    expect(unmetRequires(e, get()).map((r) => r.key)).toEqual(['B'])
    expect(unmetRequires(e, get({ B: 'on' }))).toEqual([])
  })

  it('requiredValueText: kosong = on, oneOf digabung', () => {
    expect(requiredValueText({ key: 'A' })).toBe('on')
    expect(requiredValueText({ key: 'M', oneOf: ['poll', 'webhook'] })).toBe('poll / webhook')
  })
})

describe('badge derivations', () => {
  it('isChanged membandingkan dengan default, bukan source', () => {
    expect(isChanged(mk({ source: 'override', value: 'off' }), 'off')).toBe(false)
    expect(isChanged(mk(), 'ON')).toBe(true)
    expect(isChanged(mk({ kind: 'string', default: undefined, value: '' }), '')).toBe(false)
  })

  it('isChanged secret: hanya override terisi', () => {
    expect(isChanged(mk({ kind: 'secret', source: 'override', secretSet: true }), '')).toBe(true)
    expect(isChanged(mk({ kind: 'secret', source: 'env', secretSet: true }), '')).toBe(false)
  })

  it('needsRestart: hanya boot dengan efektif beda, atau pendingRestart', () => {
    expect(needsRestart(mk({ restart: 'boot', value: 'on', effective: 'off' }))).toBe(true)
    expect(needsRestart(mk({ restart: 'boot', value: 'on', effective: 'ON' }))).toBe(false)
    expect(needsRestart(mk({ restart: 'hot', value: 'on', effective: 'off' }))).toBe(false)
    expect(needsRestart(mk({ pendingRestart: true }))).toBe(true)
    expect(activeDiffers(mk({ restart: 'boot', value: '', effective: 'poll' }))).toBe(false)
  })
})
