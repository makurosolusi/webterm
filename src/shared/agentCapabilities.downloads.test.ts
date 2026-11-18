// web.downloads in the capability registry: who gets it, how it is worded, and that the verb it names exists.
import { describe, expect, it } from 'vitest'
import { BROWSER_VERB_CAP } from './browser.contract'
import { capabilitiesOf, capabilityHash, grantedCentralTools, renderCapabilityBriefing, renderCapabilityLine } from './agentCapabilities'
import type { CapabilityId, ProfileId } from './agentCapabilities'

const levelOf = (p: ProfileId) => capabilitiesOf(p).find((c) => c.id === 'web.downloads')?.level

describe('web.downloads', () => {
  it('a plain chat and Central are granted it; the locked authors are not', () => {
    for (const p of ['chat.default', 'central.steward'] as const) expect(levelOf(p), p).toBe('granted')
    for (const p of ['central.skill-author', 'chat.skill-author'] as const) expect(levelOf(p), p).toBe('denied')
  })

  it('Central gets the read-only metadata tool, never a way to read file contents', () => {
    expect(grantedCentralTools('central.steward')).toContain('browser_downloads')
    const b = renderCapabilityBriefing('central.steward')
    expect(b).toContain('browser_downloads')
    expect(b).toContain('you never read file contents')
    expect(b).not.toContain('downloads read')
  })

  it('the chat briefing names the real verbs, no path, where the files are, and warns about untrusted files', () => {
    const b = renderCapabilityBriefing('chat.default')
    expect(b).toContain('`webterm browser downloads`')
    expect(b).toContain('`downloads read <id>`')
    expect(b).toContain('`downloads copy <id> <name>`')
    expect(b).toContain('only files of the browser wired to you')
    expect(b).not.toMatch(/\bpath\b/)
    expect(b).toContain('never the user\'s own Downloads folder')
    expect(b).toContain('download: <id>')
    expect(b).toContain('untrusted data')
    expect(Object.keys(BROWSER_VERB_CAP)).toContain('downloads')
    expect(BROWSER_VERB_CAP.downloads).toBe('browser.read')
  })

  it('a profile that is denied it never mentions it (quiet), so the authors do not claim or deny it', () => {
    for (const p of ['central.skill-author', 'chat.skill-author'] as const) {
      const b = renderCapabilityBriefing(p)
      expect(b, p).not.toContain('files a page downloaded')
      expect(b, p).not.toContain('webterm browser downloads')
    }
  })

  it('granting Central the ability changes its capability hash, so an old session gets the "Capabilities updated" note', () => {
    expect(capabilityHash('central.steward')).not.toBe(capabilityHash('central.steward', new Set<CapabilityId>(['web.downloads'])))
  })

  it('switching it off says so in the line and changes the hash (the "Capabilities updated" note)', () => {
    const off = new Set<CapabilityId>(['web.downloads'])
    expect(renderCapabilityLine('chat.default', off)).toContain('Not available right now: read files a page downloaded.')
    expect(capabilityHash('chat.default', off)).not.toBe(capabilityHash('chat.default'))
  })
})
