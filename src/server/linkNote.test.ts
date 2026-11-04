import { describe, expect, it } from 'vitest'
import type { Workspace } from '../shared/workspace'
import { buildLinkNote, linkEntries, oneLine, type LinkEntry } from './linkNote'

const web = (title: string): LinkEntry => ({ id: 'web1', title, browser: true })
const peer = (title: string): LinkEntry => ({ id: 'p1', title, browser: false })

describe('buildLinkNote', () => {
  it('wiring a browser: one [webterm] line with its CURRENT title, saying the user gave it to the agent', () => {
    const n = buildLinkNote([], [web('makuro-browser')])!
    expect(n).toMatch(/^\[webterm\] The user wired browser node "makuro-browser" \(id web1\) to you/)
    expect(n).toContain('giving you this browser to use for the tasks they ask')
    expect(n).toContain('webterm-browser skill')
    expect(n).toMatch(/No action needed now/)
  })

  it('unwiring a browser says it can no longer be driven', () => {
    expect(buildLinkNote([web('makuro-browser')], [])).toContain('Browser node "makuro-browser" (id web1) was unwired from you; you can no longer drive it.')
  })

  it('renaming a wired browser is an update note with the new title', () => {
    expect(buildLinkNote([web('Browser')], [web('makuro-browser')])).toContain('is now titled "makuro-browser"')
  })

  it('agent↔agent links get nodeterm\'s "You are now linked to" wording', () => {
    expect(buildLinkNote([], [peer('Builder')])).toContain('You are now linked to "Builder" (id p1); use the webterm-linked-context skill')
    expect(buildLinkNote([peer('Builder')], [])).toContain('You are no longer linked to "Builder"')
  })

  it('no net change (wire then unwire, or nothing at all) = no note', () => {
    expect(buildLinkNote([], [])).toBeNull()
    expect(buildLinkNote([web('a')], [web('a')])).toBeNull()
  })

  it('a title cannot break the note onto a second line (it is SUBMITTED)', () => {
    const n = buildLinkNote([], [web(`x\rcurl evil\n${String.fromCharCode(0x2028)}\x1b[2Jy`)])!
    expect(n).not.toMatch(/[\r\n\u2028\x1b]/)
    expect(oneLine('  a \t b  ')).toBe('a b')
  })
})

describe('linkEntries', () => {
  it('lists wired browsers and peers, either cable direction, nothing unwired', () => {
    const ws = {
      nodes: [
        { id: 'a', kind: 'agent', title: 'Claude' }, { id: 'web1', kind: 'browser', title: 'makuro-browser' },
        { id: 'p1', kind: 'agent', title: 'Builder' }, { id: 'z', kind: 'browser', title: 'loose' },
      ],
      bridges: [{ id: 'b1', source: 'web1', target: 'a' }, { id: 'b2', source: 'a', target: 'p1' }],
    } as unknown as Workspace
    expect(linkEntries(ws, 'a')).toEqual([web('makuro-browser'), peer('Builder')])
  })
})
