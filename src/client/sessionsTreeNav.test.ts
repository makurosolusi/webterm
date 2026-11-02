/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { edgeTarget, treeItemLabel, typeaheadTarget, visibleTreeItems } from './sessionsTreeNav'

type Item = HTMLElement & { open?: boolean }

function item(label: string, opts: { open?: boolean; group?: boolean } = {}): Item {
  const el = document.createElement('vscode-tree-item') as Item
  el.open = opts.open
  const span = document.createElement('span')
  span.className = opts.group ? 'ss-tree__group-label' : 'ss-tree__label'
  span.textContent = label
  el.append(span)
  return el
}

function fixture() {
  const root = document.createElement('div')
  const open = item('Alpha', { open: true, group: true })
  const closed = item('Beta', { open: false, group: true })
  const a1 = item('Build')
  const b1 = item('Deploy')
  open.append(a1)
  closed.append(b1)
  root.append(open, closed)
  return { root, open, closed, a1, b1 }
}

describe('sessionsTreeNav', () => {
  it('visibleTreeItems melewati anak dari branch yang tertutup', () => {
    const { root, open, closed, a1 } = fixture()
    expect(visibleTreeItems(root)).toEqual([open, a1, closed])
  })

  it('treeItemLabel membaca label item itu sendiri, bukan anak-anaknya', () => {
    const { open } = fixture()
    expect(treeItemLabel(open)).toBe('Alpha')
  })

  it('edgeTarget memilih baris pertama/terakhir dan null bila kosong', () => {
    const { root, open, closed } = fixture()
    const items = visibleTreeItems(root)
    expect(edgeTarget('Home', items)).toBe(open)
    expect(edgeTarget('End', items)).toBe(closed)
    expect(edgeTarget('End', [])).toBeNull()
  })

  it('typeaheadTarget mencari awalan, berputar, dan mengulang huruf yang sama', () => {
    const labels = ['Build', 'Bash', 'Deploy']
    expect(typeaheadTarget(labels, 'd', 0)).toBe(2)
    expect(typeaheadTarget(labels, 'b', 0)).toBe(1)
    expect(typeaheadTarget(labels, 'bb', 1)).toBe(0)
    expect(typeaheadTarget(labels, 'ba', 0)).toBe(1)
    expect(typeaheadTarget(labels, 'x', 0)).toBe(-1)
    expect(typeaheadTarget([], 'a', 0)).toBe(-1)
  })
})
