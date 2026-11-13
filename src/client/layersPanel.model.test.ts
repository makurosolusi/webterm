import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import type { TabGroup } from '../shared/tabLayout.schema'
import { UNREAD_LABEL } from './sessionSignal'
import { emptyRowId, groupsOfIds, layerRows, nodeTabItems, rangeIds, selectedInOrder, type LayerRow } from './layersPanel.model'

// test-only fixtures
const node = (id: string, type: string, title: string, extra: Partial<Node> = {}): Node =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title }, ...extra })
const nodes = [node('a', 'terminal', 'alpha'), node('b', 'agent', 'beta'), node('c', 'terminal', 'gamma'), node('d', 'editor', 'delta')]
const group = (id: string, ids: string[], extra: Partial<TabGroup> = {}): TabGroup => ({ id, name: id.toUpperCase(), collapsed: false, ids, ...extra })
const shape = (rows: LayerRow[]) => rows.map((r) => `${r.type}:${r.id}@${r.level}`)

describe('nodeTabItems', () => {
  it('follows `order`, then appends nodes it does not hold yet', () => {
    expect(nodeTabItems(nodes, ['c', 'a'], {}).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('carries the status dot for agent kinds, unread on a turn that ended, none for terminals', () => {
    const items = nodeTabItems(nodes, [], { b: 'waiting', a: 'done' }, new Set(['b', 'a']))
    expect(items.find((i) => i.id === 'b')?.signal).toEqual({ tone: 'unread', label: `Turn ended — ${UNREAD_LABEL}` })
    expect(nodeTabItems(nodes, [], { b: 'done' })[1].signal).toBeUndefined() // exited is calm: no dot
    expect(items.find((i) => i.id === 'a')?.signal).toBeUndefined()
    expect(nodeTabItems(nodes, [], { b: 'working' }, new Set(['b']))[1].signal?.tone).toBe('working')
  })
})

describe('layerRows', () => {
  const items = nodeTabItems(nodes, ['a', 'b', 'c', 'd'], {})

  it('renders a group at its first member, members indented below it, ungrouped nodes in order', () => {
    expect(shape(layerRows(items, [group('g', ['b', 'c'])]))).toEqual(['node:a@1', 'group:g@1', 'node:b@2', 'node:c@2', 'node:d@1'])
    expect(layerRows(items, [group('g', ['b', 'c'])])[1]).toMatchObject({ type: 'group', name: 'G', count: 2, expanded: true })
  })

  it('hides members of a collapsed group', () => {
    expect(shape(layerRows(items, [group('g', ['b', 'c'], { collapsed: true })]))).toEqual(['node:a@1', 'group:g@1', 'node:d@1'])
  })

  it('puts an empty group last with a "Drag nodes here" child; collapsed = no child', () => {
    const rows = layerRows(items, [group('e', []), group('g', ['a'])])
    expect(shape(rows)).toEqual(['group:g@1', 'node:a@2', 'node:b@1', 'node:c@1', 'node:d@1', 'group:e@1', `empty:${emptyRowId('e')}@2`])
    expect(shape(layerRows(items, [group('e', [], { collapsed: true })])).slice(-1)).toEqual(['group:e@1'])
  })

  it('filter matches title case-insensitively and keeps a collapsed parent group expanded', () => {
    const rows = layerRows(items, [group('g', ['b', 'c'], { collapsed: true }), group('e', [])], 'GAM')
    expect(shape(rows)).toEqual(['group:g@1', 'node:c@2'])
    expect(rows[0]).toMatchObject({ expanded: true, count: 1 })
  })

  it('filter matches the node name too; no match = no rows', () => {
    const named = nodeTabItems([node('x', 'terminal', 'shell', { data: { title: 'shell', name: 'Mango' } })], [], {})
    expect(shape(layerRows(named, [], 'mango'))).toEqual(['node:x@1'])
    expect(layerRows(named, [], 'zzz')).toEqual([])
  })
})

describe('selection helpers', () => {
  it('selectedInOrder lists selected ids in list order', () => {
    const sel = [{ id: 'd', selected: true }, { id: 'a', selected: true }, { id: 'b' }, { id: 'z', selected: true }]
    expect(selectedInOrder(sel, ['a', 'b', 'd'])).toEqual(['a', 'd', 'z'])
  })

  it('rangeIds spans both directions, falls back to the target alone', () => {
    expect(rangeIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeIds(['a', 'b', 'c'], null, 'b')).toEqual(['b'])
  })

  it('groupsOfIds returns each holding group once', () => {
    expect(groupsOfIds([group('g', ['a', 'b']), group('h', ['c']), group('i', ['d'])], ['a', 'b', 'c'])).toEqual(['g', 'h'])
  })
})
