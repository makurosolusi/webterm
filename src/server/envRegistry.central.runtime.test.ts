// CR-04: entri registry mesin agen central (RUNTIME/MODEL) dan label netral-runtime.
import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_KIND, parseRuntimeKind } from './central/runtime/runtimeFlag'
import { specFor } from './envRegistry'
import type { EnvSpec } from './envRegistry.types'
import { validateEnvValue } from './envSettings.validate'
import { parseOverrides } from './envSettings.store'

const RUNTIME = 'WEBTERM_CENTRAL_RUNTIME'
const spec = (key: string): EnvSpec => {
  const s = specFor(key)
  if (!s) throw new Error(`spec ${key} missing`)
  return s
}

describe('WEBTERM_CENTRAL_RUNTIME', () => {
  it('opsi berurutan claude, mock, off dengan label kanonik (tanpa OpenCode)', () => {
    const s = spec(RUNTIME)
    expect(s.kind).toBe('enum')
    expect(s.options).toEqual(['claude', 'mock', 'off'])
    expect(s.optionLabels).toEqual({ claude: 'Claude Code', mock: 'Demo (canned replies)', off: 'Off' })
    expect(s.label).toBe('Central agent engine')
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
    expect(s.description).toContain('Unknown value = off')
    expect(validateEnvValue(s, 'claude')).toEqual({ ok: true, value: 'claude' })
    expect(validateEnvValue(s, 'gpt').ok).toBe(false)
  })
})

describe('WEBTERM_CENTRAL_MODEL', () => {
  it('tanpa default model (kosong = bawaan runtime), berlaku untuk claude (juga otomatis)', () => {
    const s = spec('WEBTERM_CENTRAL_MODEL')
    expect(s.kind).toBe('string')
    expect(s.default ?? '').toBe('')
    expect(s.unsetLabel).toBe('Runtime default')
    expect(s.label).toBe('Model override')
    expect(s.requires).toEqual([expect.objectContaining({ key: RUNTIME, oneOf: ['claude', ''] })])
  })
})

describe('OpenCode dipensiunkan dan CA2 netral-runtime', () => {
  it('stale OpenCode keys and a stored opencode engine are ignored, not applied', () => {
    for (const k of ['WEBTERM_OPENCODE_BIN', 'WEBTERM_OPENCODE_ALLOW_TOOLS']) expect(specFor(k), k).toBeUndefined()
    const warns: string[] = []
    const parsed = parseOverrides(JSON.stringify({
      WEBTERM_OPENCODE_BIN: '/opt/opencode', WEBTERM_OPENCODE_ALLOW_TOOLS: 'on', WEBTERM_CENTRAL_RUNTIME: 'opencode',
    }), specFor, (m) => warns.push(m))
    expect(parsed.values).toEqual({})
    expect(Object.keys(parsed.unknownKept).sort()).toEqual(['WEBTERM_OPENCODE_ALLOW_TOOLS', 'WEBTERM_OPENCODE_BIN'])
    expect(warns.some((m) => m.includes('invalid stored override for WEBTERM_CENTRAL_RUNTIME'))).toBe(true)
  })

  it('CHECKPOINT tanpa requires runtime dan tanpa klausa "butuh runtime opencode"', () => {
    const s = spec('WEBTERM_CENTRAL_CHECKPOINT')
    expect((s.requires ?? []).filter((r) => r.key === RUNTIME)).toEqual([])
    expect(s.description.toLowerCase()).not.toContain('opencode')
  })
})

describe('kunci turunan central (ES-04)', () => {
  // Kunci ini diturunkan dari WEBTERM_CENTRAL dan dibaca per panggilan, jadi tak boleh berlabel restart-boot.
  it.each(['WEBTERM_CENTRAL_CHAT', 'WEBTERM_CENTRAL_MEMORY', 'WEBTERM_CENTRAL_READ_TOOLS'])('%s hot, bukan boot', (key) => {
    const s = spec(key)
    expect(s.restart).toBe('hot')
    expect(s.restartRequired).toBe(false)
  })
})
