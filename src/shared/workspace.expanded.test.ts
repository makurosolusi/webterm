import { describe, expect, it } from 'vitest'
import { normalizeWorkspace } from './workspace.schema'
import { validExpanded } from './workspace.shape'

describe('Files node expanded folders', () => {
  it('keeps relative paths, drops junk, absolute and escaping paths, dedupes', () => {
    expect(validExpanded(['src', 'src/lib', 'src', '', '/etc', '../up', 'a/../b', 'a//b', 3, null])).toEqual(['src', 'src/lib'])
    expect(validExpanded('src')).toEqual([])
  })

  it('normalizeWorkspace sanitizes a stored expanded list', () => {
    const node = { id: 'f', kind: 'files', x: 0, y: 0, dirPath: '/p', expanded: ['src', '../x'] }
    const r = normalizeWorkspace({ name: 'w', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node] })
    expect(r.board.nodes[0].expanded).toEqual(['src'])
  })
})
