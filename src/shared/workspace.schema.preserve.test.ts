import { describe, expect, it } from 'vitest'
import type { WsNode } from './workspace'
import { normalizeWorkspace, splitNodes, withPreservedNodes } from './workspace.schema'

const TERM: WsNode = { id: 't1', kind: 'terminal', x: 1, y: 2 }
const FUTURE = { id: 'x', kind: 'futureKind', position: { x: 5, y: 6 }, extra: { deep: [1, 2] } }
const BROKEN = { id: 'b1', kind: 'agent', x: 'far', y: 0 }

describe('unreadable nodes are preserved, not dropped', () => {
  it('splitNodes serves readable nodes and keeps unreadable ones that have an id, verbatim', () => {
    const got = splitNodes([TERM, FUTURE, BROKEN, 'junk', { kind: 'terminal', x: 0, y: 0 }, null])
    expect(got.nodes).toEqual([TERM])
    expect(got.preserved).toEqual([FUTURE, BROKEN])
    expect(got.preserved[0]).toBe(FUTURE) // the stored object itself, no coercion
    expect(got.issues).toHaveLength(5)
  })

  it('normalizeWorkspace still reports every issue and returns the preserved nodes beside the board', () => {
    const r = normalizeWorkspace({ name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [TERM, FUTURE] })
    expect(r.board.nodes).toEqual([TERM])
    expect(r.preserved).toEqual([FUTURE])
    expect(r.issues).toEqual(['nodes[1] kind is not a known node kind'])
  })

  it('withPreservedNodes appends stored preserved nodes the incoming board does not replace', () => {
    const moved = { ...TERM, x: 99 }
    expect(withPreservedNodes([moved], [TERM, FUTURE, BROKEN])).toEqual([moved, FUTURE, BROKEN])
    expect(withPreservedNodes([], [TERM, FUTURE])).toEqual([FUTURE]) // a removed readable node stays removed
    const reuse: WsNode = { id: 'x', kind: 'terminal', x: 0, y: 0 }
    expect(withPreservedNodes([reuse], [FUTURE])).toEqual([reuse]) // incoming wins on id clash
    expect(withPreservedNodes([TERM], null)).toEqual([TERM]) // unparsable stored column: nothing to carry
  })
})
