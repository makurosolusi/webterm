// The steward's web wording comes from the capability registry; the live on/off state comes from the tool catalog.
import { afterEach, describe, expect, it } from 'vitest'
import { renderCapabilityProse } from '../../../shared/agentCapabilities'
import { CENTRAL_STEWARD_PROMPT } from '../runtime/claudeOptions'
import { makeRig, ws } from '../../browser/browser.profiles.testkit'
import { setActiveProfiles } from '../../browser/browser.profiles.service'
import { capabilityMapLine, renderCapabilityMap, stewardOffAbilities } from './capabilityMap'

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

describe('steward and browser profiles', () => {
  afterEach(() => setActiveProfiles(null))
  const TOOLS = [...WEB, { name: 'browser_open', access: 'auto' as const }, { name: 'browser_profile', access: 'auto' as const }]

  it('the steward prompt carries the registry sentence about profiles (same words as the briefing)', () => {
    expect(CENTRAL_STEWARD_PROMPT).toContain(renderCapabilityProse('central.steward', ['web.profiles']))
    expect(CENTRAL_STEWARD_PROMPT).toContain('browser_open {"profile":"<name or id>"}')
    expect(CENTRAL_STEWARD_PROMPT).toContain('PROFILES')
  })

  it('the capability map has the profile goal; a switched-off profile tool says so from the registry', () => {
    expect(renderCapabilityMap(TOOLS)).toContain('open a browser on a profile (separate logins) or create one: browser_open (auto), browser_profile (auto)')
    const off = [{ name: 'browser_profile', access: 'off' as const }]
    expect([...stewardOffAbilities(off)]).toEqual(['web.profiles'])
    expect(renderCapabilityMap(off)).toContain('Not available right now (switched off): use browser profiles (separate logins).')
  })

  it('the live profile names end the volatile Capabilities line and follow a profile made mid-conversation', () => {
    const rig = makeRig([ws('w', 'W')])
    setActiveProfiles(rig.svc)
    rig.svc.create({ name: 'work' })
    expect(capabilityMapLine(TOOLS)).toMatch(/Browser profiles: "work", "Default \(W\)"\./)
    rig.svc.create({ name: 'personal' })
    expect(capabilityMapLine(TOOLS)).toContain('"work", "personal"')
  })

  it('no names while the profile tool is off or nothing is armed', () => {
    const rig = makeRig([ws('w', 'W')])
    setActiveProfiles(rig.svc)
    expect(capabilityMapLine([...WEB, { name: 'browser_profile', access: 'off' }])).not.toContain('Browser profiles:')
    expect(capabilityMapLine([])).toBe('')
  })
})
