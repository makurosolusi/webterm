/** @vitest-environment jsdom */
import { renderHook } from '@testing-library/react'
import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react'
import { useCallback, useState } from 'react'
import { describe, expect, it } from 'vitest'
import { withNodeNames } from '../shared/nodeNames'
import { nodeNameChanges, useBoardNodeNames } from './nodeNames.board'

const node = (id: string, name?: string): Node => ({ id, position: { x: 0, y: 0 }, data: { title: `t-${id}`, ...(name ? { name } : {}) } })

describe('nodeNameChanges', () => {
  it('names only the unnamed and the later duplicate, with the names the server would compute', () => {
    const nodes = [node('a', 'Mango'), node('b'), node('c', 'mango')]
    const changes = nodeNameChanges(nodes)
    expect(changes.map((c) => (c as { id: string }).id)).toEqual(['b', 'c'])
    const next = applyNodeChanges(changes, nodes)
    // Same pure function over the same board order = the names a server save would give.
    expect(next.map((n) => n.data.name)).toEqual(withNodeNames([{ id: 'a', name: 'Mango' }, { id: 'b' }, { id: 'c', name: 'mango' }]).map((n) => n.name))
    expect(next[0]).toBe(nodes[0]) // the named node is left alone
    expect(next[1].data.title).toBe('t-b') // other data is kept
    expect(new Set(next.map((n) => String(n.data.name).toLowerCase())).size).toBe(3)
  })

  it('a settled board emits nothing', () => {
    expect(nodeNameChanges([node('a', 'Mango'), node('b', 'Kiwi')])).toEqual([])
    expect(nodeNameChanges([])).toEqual([])
  })
})

describe('useBoardNodeNames', () => {
  it('names a new node through onNodesChange once and does not loop', () => {
    let calls = 0
    const { result } = renderHook(() => {
      const [nodes, setNodes] = useState<Node[]>([node('a', 'Mango'), node('b')])
      const onNodesChange = useCallback((c: NodeChange[]) => { calls++; setNodes((prev) => applyNodeChanges(c, prev)) }, [])
      useBoardNodeNames(nodes, onNodesChange)
      return nodes
    })
    expect(calls).toBe(1)
    expect(result.current[0].data.name).toBe('Mango')
    expect(typeof result.current[1].data.name).toBe('string')
    expect(result.current[1].data.name).not.toBe('Mango')
  })
})
