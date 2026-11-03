import { describe, it, expect, afterEach } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { capabilityAgentId, setCustomAgentBaseResolver } from '../shared/workspace'
import { nextSettings, parseStored, registerAgentBaseResolver, SettingsValidationError } from './settingsStore'

afterEach(() => setCustomAgentBaseResolver(null))

describe('parseStored', () => {
  it('returns defaults for an absent row', () => {
    expect(parseStored(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults for corrupt JSON instead of throwing', () => {
    expect(parseStored('{not json')).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps stored values and fills the rest from defaults', () => {
    const s = parseStored('{"fontSize":21}')
    expect(s.fontSize).toBe(21)
    expect(s.gridSize).toBe(DEFAULT_SETTINGS.gridSize)
  })
})

describe('nextSettings', () => {
  it('merges a patch over what is stored', () => {
    const s = nextSettings('{"fontSize":21,"snapToGrid":true}', { fontSize: 15 })
    expect(s.fontSize).toBe(15)
    expect(s.snapToGrid).toBe(true)
  })

  it('ignores a non-object patch rather than wiping the store', () => {
    expect(nextSettings('{"fontSize":21}', null).fontSize).toBe(21)
    expect(nextSettings('{"fontSize":21}', 'nope').fontSize).toBe(21)
    expect(nextSettings('{"fontSize":21}', [1, 2]).fontSize).toBe(21)
  })

  it('drops unknown keys and wrong-shaped values (mergeSettings is the input boundary)', () => {
    const s = nextSettings(null, { fontSize: '13', cursorBlink: 'yes', bogus: true })
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize)
    expect(s.cursorBlink).toBe(DEFAULT_SETTINGS.cursorBlink)
    expect('bogus' in (s as unknown as Record<string, unknown>)).toBe(false)
  })

  it('replaces array and object keys wholesale, so a removal sticks', () => {
    const stored = JSON.stringify({ customAgents: [{ id: 'custom:a', label: 'A', launchCmd: 'a' }] })
    expect(nextSettings(stored, { customAgents: [] }).customAgents).toEqual([])
    expect(nextSettings('{"agentLaunchCommands":{"claude":"wrap claude"}}', {
      agentLaunchCommands: {},
    }).agentLaunchCommands).toEqual({})
  })
})

describe('registerAgentBaseResolver', () => {
  it('lets a custom agent inherit its base harness capabilities', () => {
    let stored = nextSettings(null, {
      customAgents: [{ id: 'custom:proxy', label: 'Proxy', launchCmd: '', baseAgent: 'claude' }],
    })
    registerAgentBaseResolver(() => stored)
    expect(capabilityAgentId('custom:proxy')).toBe('claude')
    // Re-read per resolve: a later PUT /api/settings must be visible without re-registering.
    stored = nextSettings(null, { customAgents: [] })
    expect(capabilityAgentId('custom:proxy')).toBe('custom:proxy')
  })

  it('never remaps a builtin id, even if a custom agent claims it', () => {
    registerAgentBaseResolver(() =>
      nextSettings(null, {
        customAgents: [{ id: 'codex', label: 'Fake', launchCmd: '', baseAgent: 'claude' }],
      })
    )
    expect(capabilityAgentId('codex')).toBe('codex')
  })
})

describe('nextSettings customAgents strict', () => {
  const bad = { id: 'custom:b', label: 'B', launchCmd: '', launch: { program: 'bash' } }

  it('melempar SettingsValidationError berisi galat per field, tanpa memuat nilai', () => {
    let caught: unknown
    try { nextSettings(null, { customAgents: [bad] }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(SettingsValidationError)
    expect((caught as SettingsValidationError).errors).toEqual([{ index: 0, field: 'launch.program', code: 'forbidden_program' }])
  })

  it('patch tanpa customAgents tidak divalidasi; yang sah diterima', () => {
    const stored = JSON.stringify({ customAgents: [{ id: 'custom:a', label: 'A', launchCmd: '' }] })
    expect(nextSettings(stored, { fontSize: 20 }).customAgents).toHaveLength(1)
    const ok = { id: 'custom:c', label: 'C', launchCmd: '', launch: { program: 'agent' }, centralSpawn: true }
    expect(nextSettings(null, { customAgents: [ok] }).customAgents).toEqual([ok])
  })

  it('customAgents non-array dibuang diam-diam seperti kunci salah-bentuk lain', () => {
    expect(nextSettings(null, { customAgents: { not: 'an array' } }).customAgents).toEqual([])
  })

  it('load: entri rusak di store dibuang tanpa melempar', () => {
    const stored = JSON.stringify({ customAgents: [bad, { id: 'custom:a', label: 'A', launchCmd: '' }] })
    expect(parseStored(stored).customAgents.map((a) => a.id)).toEqual(['custom:a'])
  })
})
