import { describe, expect, it } from 'vitest'
import { flagOn } from './envFlag'

describe('flagOn', () => {
  it.each(['on', 'ON', 'On', ' on ', ' ON\n', '\ton'])('treats %j as on', (raw) => {
    expect(flagOn(raw)).toBe(true)
  })
  it.each(['off', 'OFF', '', '   ', 'onn', 'true', '1', 'yes', 'shadow', 'o n'])('treats %j as off', (raw) => {
    expect(flagOn(raw)).toBe(false)
  })
  it('treats unset as off', () => {
    expect(flagOn(undefined)).toBe(false)
    expect(flagOn(null)).toBe(false)
  })
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
