import { describe, expect, it } from 'vitest'
import {
  CONTEXT_LINK_VERBS,
  parseSummaryCount,
  pickLinkNode,
  renderFullTranscript,
  renderList,
  renderSummary,
  renderTerminal,
  stripAnsi,
  type LinkDoc,
  type LinkDocEntry,
} from './contextLinkRender'

const plain: LinkDocEntry = { id: 'n1', title: 'Build log' }
const named: LinkDocEntry = { id: 'n2', name: 'Kiwi', title: 'API server' }
const doc = (...links: LinkDocEntry[]): LinkDoc => ({ links })

describe('verbs', () => {
  it('lists the four verbs the route serves, in order', () => {
    expect(CONTEXT_LINK_VERBS).toEqual(['list', 'summary', 'transcript', 'terminal'])
  })
})

describe('renderList', () => {
  it('says so when there are no links', () => {
    expect(renderList(doc())).toBe('No linked nodes.')
  })
  it('bullets titles, and name + quoted title for named nodes', () => {
    expect(renderList(doc(plain, named))).toBe('Linked nodes:\n- Build log (id: n1)\n- Kiwi "API server" (id: n2)')
  })
})

describe('pickLinkNode', () => {
  it('explains how to draw an edge when nothing is linked', () => {
    expect(pickLinkNode(doc())).toEqual({ message: expect.stringContaining('Draw a context-link edge') })
  })
  it('returns the only link when none is requested', () => {
    expect(pickLinkNode(doc(named))).toEqual({ node: named })
  })
  it('asks for --node when several are linked and none is requested', () => {
    const r = pickLinkNode(doc(plain, named)) as { message: string }
    expect(r.message).toBe('Several linked nodes — re-run with --node <name|id|title>:\n- Build log (id: n1)\n- Kiwi "API server" (id: n2)')
  })
  it('matches case-insensitively by id, name or title', () => {
    expect(pickLinkNode(doc(plain, named), 'N2')).toEqual({ node: named })
    expect(pickLinkNode(doc(plain, named), 'kiwi')).toEqual({ node: named })
    expect(pickLinkNode(doc(plain, named), 'BUILD LOG')).toEqual({ node: plain })
  })
  it('prefers id over name over title when they collide', () => {
    const a: LinkDocEntry = { id: 'x', title: 'zed' }
    const b: LinkDocEntry = { id: 'y', name: 'x', title: 'x' }
    const c: LinkDocEntry = { id: 'z', name: 'q', title: 'q' }
    expect(pickLinkNode(doc(b, a), 'x')).toEqual({ node: a })
    expect(pickLinkNode(doc(c, { id: 'w', title: 'q' }), 'q')).toEqual({ node: c })
  })
  it('lists the candidates when nothing matches', () => {
    const r = pickLinkNode(doc(plain, named), 'nope') as { message: string }
    expect(r.message).toBe('No linked node matches "nope". Linked: Build log, Kiwi "API server"')
  })
})

describe('renderSummary / renderFullTranscript', () => {
  it('summary keeps the last n lines under a header', () => {
    expect(renderSummary(plain, ['a', 'b', 'c'], 2)).toBe('=== Build log — last 2 lines ===\nb\nc')
  })
  it('summary with n larger than the transcript shows everything', () => {
    expect(renderSummary(named, ['a'], 9)).toBe('=== Kiwi "API server" — last 9 lines ===\na')
  })
  it('full transcript reports the line count', () => {
    expect(renderFullTranscript(named, ['a', 'b'])).toBe('=== Kiwi "API server" — full transcript (2 lines) ===\na\nb')
    expect(renderFullTranscript(plain, [])).toBe('=== Build log — full transcript (0 lines) ===')
  })
})

describe('renderTerminal', () => {
  it('trims trailing whitespace only', () => {
    expect(renderTerminal(plain, '  out\n\n \t')).toBe('=== Build log — terminal ===\n  out')
  })
  it('reports a session that is not running when nothing was captured', () => {
    expect(renderTerminal(plain, ' \n')).toBe('=== Build log — terminal ===\n"Build log" terminal session is not running.')
  })
})

describe('parseSummaryCount', () => {
  it.each([
    [undefined, 15],
    ['', 15],
    ['abc', 15],
    ['0', 15],
    ['-4', 15],
    ['7', 7],
    ['12lines', 12],
  ])('%j -> %i', (raw, expected) => {
    expect(parseSummaryCount(raw)).toBe(expected)
  })
})

describe('stripAnsi', () => {
  it('removes colour, cursor and private-mode CSI sequences', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b[2K\x1b[?25lx')).toBe('red x')
  })
  it('removes OSC titles ended by BEL or ST', () => {
    expect(stripAnsi('\x1b]0;title\x07a\x1b]8;;http://x\x1b\\b')).toBe('ab')
  })
  it('leaves ordinary text untouched', () => {
    expect(stripAnsi('plain [text] 100%')).toBe('plain [text] 100%')
  })
})
