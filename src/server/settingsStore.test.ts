import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings'
import { capabilityAgentId, setCustomAgentBaseResolver } from '../shared/workspace'
import { configureLogging, getLogLevel, logBus, setLogLevel } from './logs'
import { nextSettings, nextSettingsDocument, parseStored, registerAgentBaseResolver, SettingsValidationError } from './settingsStore'

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
        customAgents: [{ id: 'claude', label: 'Fake', launchCmd: '' }],
      })
    )
    expect(capabilityAgentId('claude')).toBe('claude')
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

describe('nextSettingsDocument: the raw stored document is the source of truth', () => {
  const bg = (color: string) => ({ ...DEFAULT_SETTINGS.canvasBackground, mode: 'color' as const, color })

  it('a ws2-only wallpaper patch keeps ws1 (a stale tab cannot wipe other entries)', () => {
    const stored = JSON.stringify({ canvasBackgroundByWorkspace: { ws1: bg('#111111') } })
    const { doc, settings } = nextSettingsDocument(stored, { canvasBackgroundByWorkspace: { ws2: bg('#222222') } })
    expect(settings.canvasBackgroundByWorkspace.ws1?.color).toBe('#111111')
    expect(settings.canvasBackgroundByWorkspace.ws2?.color).toBe('#222222')
    expect(Object.keys(doc.canvasBackgroundByWorkspace as object).sort()).toEqual(['ws1', 'ws2'])
  })

  it('a null wallpaper entry deletes only that entry', () => {
    const stored = JSON.stringify({ canvasBackgroundByWorkspace: { ws1: bg('#111111'), ws2: bg('#222222') } })
    const s = nextSettings(stored, { canvasBackgroundByWorkspace: { ws1: null } })
    expect(Object.keys(s.canvasBackgroundByWorkspace)).toEqual(['ws2'])
  })

  it('an unrelated patch keeps unknown keys and custom agents invalid today', () => {
    const invalid = { id: 'custom:x', label: 'X', launchCmd: '', launch: { program: 'bash' } }
    const stored = JSON.stringify({ futureKey: 42, customAgents: [invalid] })
    const { doc, settings } = nextSettingsDocument(stored, { fontSize: 15 })
    expect(doc.futureKey).toBe(42)
    expect(doc.customAgents).toEqual([invalid])
    expect(doc.fontSize).toBe(15)
    expect(settings.customAgents).toEqual([]) // the read view still filters it
  })

  it('validates only patched keys: a wrong-shaped patch value leaves the stored one untouched', () => {
    const { doc } = nextSettingsDocument('{"fontSize":21,"customAgents":"future-format"}', { fontSize: 'big', customAgents: { no: 1 } })
    expect(doc.fontSize).toBe(21)
    expect(doc.customAgents).toBe('future-format')
  })

  it('writes patched keys in normalized form and drops unknown patch keys', () => {
    const { doc } = nextSettingsDocument(null, { fontSize: 9999, bogus: true })
    expect(doc.fontSize).toBe(nextSettings(null, { fontSize: 9999 }).fontSize)
    expect('bogus' in doc).toBe(false)
  })

  it('persists the one-time legacy claude command -> profile migration with the write', () => {
    const { doc } = nextSettingsDocument('{"agentLaunchCommands":{"claude":"wrap claude"}}', { fontSize: 14 })
    expect(Array.isArray(doc.claudeLaunchProfiles)).toBe(true)
    expect((doc.claudeLaunchProfiles as unknown[]).length).toBe(1)
  })
})

describe('nextSettingsDocument: a corrupt stored row', () => {
  let prevLevel: ReturnType<typeof getLogLevel>
  beforeAll(() => {
    prevLevel = getLogLevel()
    setLogLevel('trace')
    configureLogging({ console: false, env: { WEBTERM_LOG_FILE: 'off' } })
  })
  afterAll(() => {
    setLogLevel(prevLevel)
    configureLogging({ console: true, env: { WEBTERM_LOG_FILE: 'off' } })
  })

  it('logs one warning with context but no content, and the patch still succeeds', () => {
    logBus.clear()
    const { doc, settings } = nextSettingsDocument('{"secretSentinel":"do-not-log-me"', { fontSize: 18 })
    expect(settings.fontSize).toBe(18)
    expect(doc.fontSize).toBe(18)
    const warns = logBus.snapshot().filter((e) => e.event === 'settings.read.corrupt')
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ level: 'warn', data: { operation: 'settings read', key: 'settings' } })
    expect(typeof (warns[0].data as Record<string, unknown>).cause).toBe('string')
    expect(JSON.stringify(logBus.snapshot())).not.toContain('do-not-log-me')
  })

  it('parseStored: a corrupt row yields defaults and warns once across repeated reads', () => {
    logBus.clear()
    const row = '{"parseSentinel":"do-not-log-me-either"'
    expect(parseStored(row)).toEqual(DEFAULT_SETTINGS)
    expect(parseStored(row)).toEqual(DEFAULT_SETTINGS)
    const warns = logBus.snapshot().filter((e) => e.event === 'settings.read.corrupt')
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ level: 'warn', data: { operation: 'settings read', key: 'settings' } })
    expect(JSON.stringify(logBus.snapshot())).not.toContain('do-not-log-me-either')
  })

  it('an empty document normalizes exactly like an absent row', () => {
    expect(mergeSettings({})).toEqual(mergeSettings(null))
  })
})
