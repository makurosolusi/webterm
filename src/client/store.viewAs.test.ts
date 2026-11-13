import { describe, expect, it } from 'vitest'
import { splitNodes } from '../shared/workspace.schema'
import { toFlow, toWsNode } from './store'

const ED = { id: 'e', kind: 'editor' as const, x: 0, y: 0, filePath: '/r/logo.svg' }

describe('editor viewAs (Open as Text) persists', () => {
  it('round-trips viewAs: text through the store; absent stays absent', () => {
    expect(toWsNode(toFlow({ ...ED, viewAs: 'text' })).viewAs).toBe('text')
    expect(toWsNode(toFlow(ED)).viewAs).toBeUndefined()
  })

  it('drops junk viewAs from node data and from stored workspaces', () => {
    expect(toWsNode(toFlow({ ...ED, viewAs: 'hex' as unknown as 'text' })).viewAs).toBeUndefined()
    const { nodes } = splitNodes([{ ...ED, viewAs: 'hex' }, { ...ED, id: 'f', viewAs: 'text' }, { ...ED, id: 'g' }])
    expect(nodes.map((n) => n.viewAs)).toEqual([undefined, 'text', undefined])
    expect('viewAs' in nodes[0]).toBe(false)
  })
})
