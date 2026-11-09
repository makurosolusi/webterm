// Rows of the Layers panel (Figma Layers / VS Code tree), pure: nodes in `tabs.order`, list-only
// groups rendered at their first member's position, empty groups last. Absorbs `nodeTabItems` of
// the old canvas tab strip, so the status dot and label rules stay the ones tab mode uses.
import type { Node } from '@xyflow/react'
import type { AgentStatus, WsNode, WsNodeKind } from '../shared/workspace'
import type { TabGroup } from '../shared/tabLayout.schema'
import { KIND_ICON, nodeRowLabel } from './nodeList'
import { nodeTabSignal, type SessionSignal } from './sessionSignal'

export const kindOf = (n: Node): WsNodeKind => (n.type as WsNodeKind | undefined) ?? 'terminal'

/** One node as a list item: `title` is the editable label, `name` the node's fixed name. */
export interface NodeItem { id: string; kind: WsNodeKind; icon: string; title: string; name?: string; signal?: SessionSignal }

/** Items in list order: `order` first, then nodes it does not hold yet (before the first reconcile) in board order. */
export function nodeTabItems(
  nodes: readonly Node[], order: readonly string[], statuses: Record<string, AgentStatus>, unread: ReadonlySet<string> = new Set(),
): NodeItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ids = [...order.filter((id) => byId.has(id)), ...nodes.map((n) => n.id).filter((id) => !order.includes(id))]
  return ids.map((id) => {
    const n = byId.get(id) as Node
    const kind = kindOf(n)
    return {
      id, kind, icon: KIND_ICON[kind],
      title: nodeRowLabel({ ...(n.data as Partial<WsNode>), id, kind } as WsNode),
      name: (n.data as Partial<WsNode>).name,
      signal: nodeTabSignal(kind, statuses[id], unread.has(id)),
    }
  })
}

export type LayerRow =
  | { type: 'group'; id: string; name: string; count: number; expanded: boolean; level: 1 }
  | { type: 'node'; id: string; item: NodeItem; groupId: string | null; level: 1 | 2 }
  | { type: 'empty'; id: string; groupId: string; level: 2 }

/** Row key of a group's "Drag nodes here" child (never collides with node ids, which have no `#`). */
export const emptyRowId = (groupId: string): string => `${groupId}#empty`

const matches = (item: NodeItem, q: string): boolean =>
  item.title.toLowerCase().includes(q) || (item.name ?? '').toLowerCase().includes(q)

/**
 * Flat, render-ready rows. `filter` (case-insensitive, title or name) hides non-matching nodes;
 * a group with a matching member stays and is shown expanded; empty groups are hidden while filtering.
 */
export function layerRows(items: readonly NodeItem[], groups: readonly TabGroup[], filter = ''): LayerRow[] {
  const q = filter.trim().toLowerCase()
  const groupOfId = new Map<string, TabGroup>()
  for (const g of groups) for (const id of g.ids) groupOfId.set(id, g)
  const shown = q ? items.filter((i) => matches(i, q)) : items
  const rows: LayerRow[] = []
  const emitted = new Set<string>()
  for (const item of shown) {
    const g = groupOfId.get(item.id)
    if (!g) { rows.push({ type: 'node', id: item.id, item, groupId: null, level: 1 }); continue }
    if (emitted.has(g.id)) continue
    emitted.add(g.id)
    const members = shown.filter((i) => groupOfId.get(i.id) === g)
    const expanded = !!q || !g.collapsed
    rows.push({ type: 'group', id: g.id, name: g.name, count: members.length, expanded, level: 1 })
    if (expanded) for (const m of members) rows.push({ type: 'node', id: m.id, item: m, groupId: g.id, level: 2 })
  }
  if (q) return rows
  const live = new Set(items.map((i) => i.id))
  for (const g of groups) {
    if (emitted.has(g.id) || g.ids.some((id) => live.has(id))) continue
    rows.push({ type: 'group', id: g.id, name: g.name, count: 0, expanded: !g.collapsed, level: 1 })
    if (!g.collapsed) rows.push({ type: 'empty', id: emptyRowId(g.id), groupId: g.id, level: 2 })
  }
  return rows
}

/** Ids of the selected nodes, in list (`order`) order; nodes `order` does not hold yet go last. */
export function selectedInOrder(nodes: readonly Pick<Node, 'id' | 'selected'>[], order: readonly string[]): string[] {
  const sel = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
  return [...order.filter((id) => sel.has(id)), ...[...sel].filter((id) => !order.includes(id))]
}

/** Live member ids of a group, in list order. */
export const groupMembers = (rows: readonly NodeItem[], g: TabGroup | undefined): string[] =>
  g ? rows.filter((i) => g.ids.includes(i.id)).map((i) => i.id) : []

/** Node ids between `a` and `b` (inclusive) in `ids` order; just `b` when `a` is not in the list. */
export function rangeIds(ids: readonly string[], a: string | null, b: string): string[] {
  const i = a === null ? -1 : ids.indexOf(a)
  const j = ids.indexOf(b)
  if (i < 0 || j < 0) return [b]
  return ids.slice(Math.min(i, j), Math.max(i, j) + 1)
}

/** Ids of the groups holding any of `ids`, each once, in group order. */
export const groupsOfIds = (groups: readonly TabGroup[], ids: readonly string[]): string[] =>
  groups.filter((g) => g.ids.some((id) => ids.includes(id))).map((g) => g.id)
