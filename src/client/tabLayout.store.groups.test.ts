// Locks the server's port of the Layers group rules (`server/canvas/canvasPush.layout.ts`, used by
// Central's canvas.group) to the human's store actions: the same edit gives the same order and groups.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGroupOp, type GroupOp, type GroupTabs } from '../server/canvas/canvasPush.layout'
import { defaultTabLayout, type TabLayout } from '../shared/tabLayout.schema'
import {
  connectTabLayout, createGroup, getTabLayout, moveToGroup, receiveGroups, renameGroup, toggleGroup, ungroup,
} from './tabLayout.store'

const ORDER = ['a', 'b', 'c', 'd', 'e']
const tabsNow = (): GroupTabs => ({ order: getTabLayout().tabs.order, groups: getTabLayout().tabs.groups })

/** Run `op` on the server port, then `human` on the store from the same state; both must agree. */
function same(op: (ids: Record<string, string>) => GroupOp, human: (ids: Record<string, string>) => void, ids: Record<string, string>): void {
  const server = applyGroupOp(tabsNow(), op(ids), 'g-new')
  if (!server.ok) throw new Error(`server refused: ${server.code}`)
  human(ids)
  const client = tabsNow()
  const created = client.groups.find((g) => !Object.values(ids).includes(g.id))
  // The store mints its own random id for a created group; map it to the server's before comparing.
  const norm = (t: GroupTabs) => ({ order: t.order, groups: t.groups.map((g) => (g.id === created?.id ? { ...g, id: 'g-new' } : g)) })
  expect(norm(client)).toEqual(server.tabs)
  if (created) ids.new = created.id
}

describe('server group rules mirror the store', () => {
  beforeEach(() => {
    const base = defaultTabLayout()
    connectTabLayout({ ...base, tabs: { ...base.tabs, order: ORDER, active: 'a' } }, null)
  })

  it('create (named, default name, stealing members), add, remove, rename, collapse, ungroup', () => {
    const ids: Record<string, string> = {}
    same(() => ({ op: 'create', name: 'Docs', nodeIds: ['d', 'b'] }), () => { createGroup(['d', 'b'], 'Docs') }, ids)
    ids.docs = ids.new
    same(() => ({ op: 'create', nodeIds: ['b', 'e'] }), () => { createGroup(['b', 'e']) }, ids) // "Group 1", b leaves Docs
    ids.g1 = ids.new
    same((x) => ({ op: 'add', group: x.docs, nodeIds: ['a', 'e'] }), (x) => { moveToGroup('a', x.docs); moveToGroup('e', x.docs) }, ids)
    // "Remove from Group" (layersPanel): before the row that follows the group's last member.
    const last = getTabLayout().tabs.groups.find((g) => g.id === ids.docs)!.ids.at(-1)!
    const after = getTabLayout().tabs.order[getTabLayout().tabs.order.indexOf(last) + 1] ?? null
    same((x) => ({ op: 'remove', group: x.docs, nodeIds: ['d'] }), () => moveToGroup('d', null, after), ids)
    same((x) => ({ op: 'rename', group: x.g1, name: '  Web  ' }), (x) => renameGroup(x.g1, '  Web  '), ids)
    same((x) => ({ op: 'collapse', group: x.g1, collapsed: true }), (x) => toggleGroup(x.g1, true), ids)
    same((x) => ({ op: 'ungroup', group: x.docs }), (x) => ungroup(x.docs), ids)
    expect(getTabLayout().tabs.groups.map((g) => g.name)).toEqual(['Web'])
  })
})

describe('receiveGroups', () => {
  it('shows a pushed group list re-packed into the local order, without persisting', () => {
    const write = vi.fn<(next: TabLayout) => void>()
    const base = defaultTabLayout()
    connectTabLayout({ ...base, mode: 'tabs', tabs: { ...base.tabs, order: ['a', 'b', 'c'], active: 'c' } }, write)
    // a node the server grouped but this window has not reconciled yet ('z') is appended first
    const out = receiveGroups([{ id: 'g1', name: 'Docs', collapsed: true, ids: ['c', 'a', 'z'] }])
    expect(out).toBe(getTabLayout())
    expect(out.mode).toBe('tabs')
    expect(out.tabs).toMatchObject({ active: 'c', order: ['a', 'c', 'z', 'b'], groups: [{ id: 'g1', ids: ['a', 'c', 'z'], collapsed: true }] })
    expect(write).not.toHaveBeenCalled()
  })
})
