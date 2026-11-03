import { describe, expect, it } from 'vitest'
import { flagOn, flagOr, parseFlag, strictFlag } from './envFlag'

describe('flagOn', () => {
  it.each(['on', 'ON', 'On', ' on ', ' ON\n', '\ton', '1', 'true', 'TRUE'])('treats %j as on', (raw) => {
    expect(flagOn(raw)).toBe(true)
  })
  it.each(['off', 'OFF', '0', 'false', '', '   ', 'onn', 'yes', 'shadow', 'o n'])('treats %j as off', (raw) => {
    expect(flagOn(raw)).toBe(false)
  })
  it('treats unset as off', () => {
    expect(flagOn(undefined)).toBe(false)
    expect(flagOn(null)).toBe(false)
  })
})

describe('parseFlag', () => {
  it.each(['on', 'ON', '1', 'true', ' on '])('%j => on', (raw) => expect(parseFlag(raw)).toBe('on'))
  it.each(['off', '0', 'false', ' FALSE '])('%j => off', (raw) => expect(parseFlag(raw)).toBe('off'))
  it.each(['', 'yes', 'onn'])('%j => undefined', (raw) => expect(parseFlag(raw)).toBeUndefined())
  it('onn tetap off (fail-closed)', () => expect(flagOn('onn')).toBe(false))
})

describe('flags that used to be strict now share the loose semantics', () => {
  it('orchestrator run and memory files accept " ON "', async () => {
    const { orchestratorRunEnabled, orchestratorRunRequireApproval } = await import('./orchestratorRunModel')
    const { memoryFilesEnabled } = await import('./memory/memoryFilePath')
    const env = { WEBTERM_CENTRAL: 'on', WEBTERM_ORCHESTRATOR_RUN: ' ON ', WEBTERM_RUN_REQUIRE_APPROVAL: 'On', WEBTERM_MEMORY_FILES: ' on' }
    expect(orchestratorRunEnabled(env)).toBe(true)
    expect(orchestratorRunRequireApproval(env)).toBe(true)
    expect(memoryFilesEnabled(env)).toBe(true)
    expect(orchestratorRunEnabled({ WEBTERM_ORCHESTRATOR_RUN: 'off' })).toBe(false)
    expect(memoryFilesEnabled({})).toBe(false)
  })
})

describe('flagOr (dialek kanonik, default pemanggil)', () => {
  it.each(['on', 'ON', '1', 'true', ' true '])('%j => true walau default false', (raw) => expect(flagOr(raw, false)).toBe(true))
  it.each(['off', 'OFF', '0', 'false', ' False '])('%j => false walau default true', (raw) => expect(flagOr(raw, true)).toBe(false))
  it.each(['yes', '2', '', '   ', 'onn'])('%j => default pemanggil', (raw) => {
    expect(flagOr(raw, true)).toBe(true)
    expect(flagOr(raw, false)).toBe(false)
  })
  it('unset => default pemanggil', () => {
    expect(flagOr(undefined, true)).toBe(true)
    expect(flagOr(null, false)).toBe(false)
  })
})

describe('strictFlag (tiga kunci keamanan)', () => {
  it('hanya persis "1"', () => expect(strictFlag('1')).toBe(true))
  it.each(['on', 'true', ' 1', '1 ', 'ON', '0', '', 'yes'])('%j => false', (raw) => expect(strictFlag(raw)).toBe(false))
  it('unset => false', () => {
    expect(strictFlag(undefined)).toBe(false)
    expect(strictFlag(null)).toBe(false)
  })
})
