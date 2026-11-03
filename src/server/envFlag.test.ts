import { describe, expect, it } from 'vitest'
import { flagOn, parseFlag } from './envFlag'

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
    const env = { WEBTERM_ORCHESTRATOR_RUN: ' ON ', WEBTERM_RUN_REQUIRE_APPROVAL: 'On', WEBTERM_MEMORY_FILES: ' on' }
    expect(orchestratorRunEnabled(env)).toBe(true)
    expect(orchestratorRunRequireApproval(env)).toBe(true)
    expect(memoryFilesEnabled(env)).toBe(true)
    expect(orchestratorRunEnabled({ WEBTERM_ORCHESTRATOR_RUN: 'off' })).toBe(false)
    expect(memoryFilesEnabled({})).toBe(false)
  })
})
