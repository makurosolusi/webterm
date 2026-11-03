// CR-04: entri registry mesin agen central (RUNTIME/MODEL) dan label netral-runtime.
import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_KIND, parseRuntimeKind } from './central/runtime/runtimeFlag'
import { specFor } from './envRegistry'
import type { EnvSpec } from './envRegistry.types'
import { validateEnvValue } from './envSettings.validate'

const RUNTIME = 'WEBTERM_CENTRAL_RUNTIME'
const spec = (key: string): EnvSpec => {
  const s = specFor(key)
  if (!s) throw new Error(`spec ${key} missing`)
  return s
}

describe('WEBTERM_CENTRAL_RUNTIME', () => {
  it('opsi berurutan claude, opencode, mock, off dengan label kanonik', () => {
    const s = spec(RUNTIME)
    expect(s.kind).toBe('enum')
    expect(s.options).toEqual(['claude', 'opencode', 'mock', 'off'])
    expect(s.optionLabels).toEqual({
      claude: 'Claude Code', opencode: 'OpenCode (model gratis/pihak ketiga)', mock: 'Demo (jawaban tiruan)', off: 'Nonaktif',
    })
    expect(s.label).toBe('Mesin agen central')
  })

  it('default registry = DEFAULT_RUNTIME_KIND dan tiap opsi round-trip parseRuntimeKind', () => {
    const s = spec(RUNTIME)
    expect(s.default).toBe(DEFAULT_RUNTIME_KIND)
    for (const o of s.options ?? []) expect(parseRuntimeKind(o), o).toBe(o)
  })

  it('tetap hot, butuh Central, deskripsi menyebut nilai tak dikenal = nonaktif', () => {
    const s = spec(RUNTIME)
    expect(s).toMatchObject({ restart: 'hot', restartRequired: false, owner: 'central', audience: 'user' })
    expect(s.requires?.map((r) => r.key)).toEqual(['WEBTERM_CENTRAL'])
    expect(s.description).toContain('Nilai tak dikenal = nonaktif')
    expect(validateEnvValue(s, 'claude')).toEqual({ ok: true, value: 'claude' })
    expect(validateEnvValue(s, 'gpt').ok).toBe(false)
  })
})

describe('WEBTERM_CENTRAL_MODEL', () => {
  it('tanpa default model (kosong = bawaan runtime), berlaku untuk opencode dan claude', () => {
    const s = spec('WEBTERM_CENTRAL_MODEL')
    expect(s.kind).toBe('string')
    expect(s.default ?? '').toBe('')
    expect(s.unsetLabel).toBe('Bawaan runtime')
    expect(s.label).toBe('Model (OpenCode / Claude)')
    expect(s.requires).toEqual([expect.objectContaining({ key: RUNTIME, oneOf: ['opencode', 'claude'] })])
  })
})

describe('entri khusus OpenCode dan CA2 netral-runtime', () => {
  it('BIN dan ALLOW_TOOLS diawali "Hanya bila mesin = OpenCode."', () => {
    for (const k of ['WEBTERM_OPENCODE_BIN', 'WEBTERM_OPENCODE_ALLOW_TOOLS']) {
      expect(spec(k).description.startsWith('Hanya bila mesin = OpenCode.'), k).toBe(true)
    }
  })

  it('CHECKPOINT tanpa requires runtime dan tanpa klausa "butuh runtime opencode"', () => {
    const s = spec('WEBTERM_CENTRAL_CHECKPOINT')
    expect((s.requires ?? []).filter((r) => r.key === RUNTIME)).toEqual([])
    expect(s.description.toLowerCase()).not.toContain('runtime opencode')
  })

  it('TOOL_BRIDGE: opsi tak berubah, deskripsi tidak mengklaim jembatan terpasang', () => {
    const s = spec('WEBTERM_CENTRAL_TOOL_BRIDGE')
    expect(s.options).toEqual(['text', 'opencode'])
    expect(s.default).toBe('text')
    expect(s.description).toContain('Belum dipakai server')
  })
})
