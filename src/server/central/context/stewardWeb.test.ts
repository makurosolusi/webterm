// The steward's web wording comes from the capability registry; the live on/off state comes from the tool catalog.
import { describe, expect, it } from 'vitest'
import { renderCapabilityProse } from '../../../shared/agentCapabilities'
import { CENTRAL_STEWARD_PROMPT } from '../runtime/claudeOptions'
import { renderCapabilityMap, stewardOffAbilities } from './capabilityMap'

const WEB = [{ name: 'browser_read', access: 'auto' as const }, { name: 'browser_act', access: 'asks' as const }]

describe('steward web sentences', () => {
  it('the steward prompt carries the registry sentences for reading and driving, not hand-written ones', () => {
    expect(CENTRAL_STEWARD_PROMPT).toContain(renderCapabilityProse('central.steward', ['web.read', 'web.drive']))
    expect(CENTRAL_STEWARD_PROMPT).toContain('Read public web pages, read-only')
    expect(CENTRAL_STEWARD_PROMPT).toContain('How: browser_read {"url"')
    expect(CENTRAL_STEWARD_PROMPT).toContain('How: browser_act, browser_open')
  })

  it('the capability map keeps its goals and access words', () => {
    const map = renderCapabilityMap(WEB)
    expect(map).toContain('read one web page: browser_read (auto)')
    expect(map).toContain('browse yourself: browser_act (asks)')
    expect(map).not.toContain('Not available right now')
  })

  it('a switched-off browser tool says so in the live line, from the registry', () => {
    const tools = [{ name: 'browser_read', access: 'off' as const }, { name: 'browser_act', access: 'off' as const }]
    expect([...stewardOffAbilities(tools)].sort()).toEqual(['web.drive', 'web.read'])
    const map = renderCapabilityMap(tools)
    expect(map).toContain('read one web page: browser_read (off)')
    expect(map).toContain('Not available right now (switched off): read public web pages (read-only). Not available right now (switched off): drive web pages.')
  })

  it('only the tool that is off is reported', () => {
    const map = renderCapabilityMap([{ name: 'browser_read', access: 'auto' }, { name: 'browser_act', access: 'off' }])
    expect(map).toContain('Not available right now (switched off): drive web pages.')
    expect(map).not.toContain('read public web pages (read-only).')
  })
})
