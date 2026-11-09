// Layers group edits on a stored tab layout, for `CanvasPush.groups` (Central's canvas.group). Pure,
// and a port of the human's actions in client `tabLayout.store.ts` (createGroup, moveToGroup,
// renameGroup, toggleGroup, ungroup) and the Layers "Remove from Group" item (`layersPanel.tsx`):
// a node is in at most one group, members stay contiguous in `order` (`packGroups`), a group emptied
// by a move stays. client `tabLayout.store.groups.test.ts` locks the two copies together.
import {
  DEFAULT_TAB_GROUP_NAME, MAX_TAB_GROUPS, cleanGroupName, packGroups, type TabGroup,
} from '../../shared/tabLayout.schema'

export interface GroupTabs { order: string[]; groups: TabGroup[] }

/** One group edit. `group` = a group id, or a group name in any case; `nodeIds` are node ids. */
export type GroupOp =
  | { op: 'create'; name?: string; nodeIds: string[] }
  | { op: 'add'; group: string; nodeIds: string[] }
  | { op: 'remove'; group: string; nodeIds: string[] }
  | { op: 'rename'; group: string; name: string }
  | { op: 'ungroup'; group: string }
  | { op: 'collapse'; group: string; collapsed: boolean }

export type GroupOpCode = 'node_not_found' | 'group_not_found' | 'group_ambiguous' | 'group_limit' | 'node_not_in_group'
export type GroupOpResult = { ok: true; tabs: GroupTabs; groupId?: string } | { ok: false; code: GroupOpCode }

const commit = (order: readonly string[], groups: readonly TabGroup[]): GroupTabs => packGroups(order, groups)

/** Lowest free "Group N" name (store `nextGroupName`). */
function nextGroupName(groups: readonly TabGroup[]): string {
  const used = new Set(groups.map((g) => g.name))
  let n = 1
  while (used.has(`${DEFAULT_TAB_GROUP_NAME} ${n}`)) n++
  return `${DEFAULT_TAB_GROUP_NAME} ${n}`
}

/** Store `moveToGroup`, line for line: node `id` into group `groupId` (null = top level), before `beforeId`. */
export function moveToGroup(t: GroupTabs, id: string, groupId: string | null, beforeId?: string | null): GroupTabs {
  const target = groupId === null ? null : t.groups.find((g) => g.id === groupId)
  if (!t.order.includes(id) || target === undefined) return t
  const groups = t.groups.map((g) => {
    const ids = g.ids.filter((m) => m !== id)
    return g === target ? { ...g, ids: [...ids, id] } : { ...g, ids }
  })
  const at = t.order.indexOf(id)
  const rest = t.order.filter((m) => m !== id)
  const before = beforeId && beforeId !== id && rest.includes(beforeId) ? beforeId : null
  const beforeGroup = before === null ? undefined : t.groups.find((g) => g.ids.includes(before))
  let index: number
  if (before !== null && target !== null && beforeGroup === target) index = rest.indexOf(before)
  else if (before !== null && target === null) index = rest.indexOf(beforeGroup ? beforeGroup.ids.find((m) => m !== id) ?? before : before)
  else if (beforeId === id) index = at
  else if (target === null) index = rest.length
  else {
    const others = target.ids.filter((m) => m !== id)
    index = others.length ? rest.indexOf(others[others.length - 1]) + 1 : at
  }
  return commit([...rest.slice(0, index), id, ...rest.slice(index)], groups)
}

/** The group `ref` names: an exact id wins, else a case-insensitive name that only one group has. */
export function findGroup(groups: readonly TabGroup[], ref: string): TabGroup | GroupOpCode {
  const byId = groups.find((g) => g.id === ref)
  if (byId) return byId
  const named = groups.filter((g) => g.name.toLowerCase() === ref.toLowerCase())
  return named.length === 1 ? named[0] : named.length ? 'group_ambiguous' : 'group_not_found'
}

/** Apply `op` to `t` (every node id must be in `t.order`); `newId` names a created group. */
export function applyGroupOp(t: GroupTabs, op: GroupOp, newId: string): GroupOpResult {
  if ('nodeIds' in op && op.nodeIds.some((id) => !t.order.includes(id))) return { ok: false, code: 'node_not_found' }
  if (op.op === 'create') {
    // Store `createGroup`.
    if (t.groups.length >= MAX_TAB_GROUPS) return { ok: false, code: 'group_limit' }
    const members = [...new Set(op.nodeIds)]
    const taken = new Set(members)
    const label = op.name?.trim() ? cleanGroupName(op.name) : nextGroupName(t.groups)
    const groups = t.groups.map((g) => ({ ...g, ids: g.ids.filter((m) => !taken.has(m)) }))
    return { ok: true, tabs: commit(t.order, [...groups, { id: newId, name: label, collapsed: false, ids: members }]), groupId: newId }
  }
  const g = findGroup(t.groups, op.group)
  if (typeof g === 'string') return { ok: false, code: g }
  const each = (fn: (g: TabGroup) => TabGroup): GroupTabs => commit(t.order, t.groups.map((x) => (x.id === g.id ? fn(x) : x)))
  switch (op.op) {
    case 'add': // the Layers drop onto a group row: each node to the end of the group
      return { ok: true, tabs: op.nodeIds.reduce((acc, id) => moveToGroup(acc, id, g.id), t), groupId: g.id }
    case 'remove': {
      if (op.nodeIds.some((id) => !g.ids.includes(id))) return { ok: false, code: 'node_not_in_group' }
      // "Remove from Group": out of the group but in place, before whatever follows its last member.
      const after = t.order[t.order.indexOf(g.ids[g.ids.length - 1]) + 1] ?? null
      return { ok: true, tabs: op.nodeIds.reduce((acc, id) => moveToGroup(acc, id, null, after), t), groupId: g.id }
    }
    case 'rename': return { ok: true, tabs: each((x) => ({ ...x, name: cleanGroupName(op.name) })), groupId: g.id }
    case 'collapse': return { ok: true, tabs: each((x) => ({ ...x, collapsed: op.collapsed })), groupId: g.id }
    case 'ungroup': return { ok: true, tabs: commit(t.order, t.groups.filter((x) => x.id !== g.id)) }
  }
}
