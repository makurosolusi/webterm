// Layers panel body (Figma Layers, VS Code tree look): every node of the open board in `tabs.order`
// with list-only groups. Click = select + reveal (the old tab strip's jump), Shift/Mod-click =
// multi-select, group click = select its members and fit them, hover outlines the node on the
// canvas, double-click/F2 renames, native drag and drop moves rows into, out of and between groups.
// The section header ("Layers" + twisty) belongs to the host sidebar.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent, RefObject } from 'react'
import type { Node, ReactFlowInstance } from '@xyflow/react'
import type { AgentStatus } from '../shared/workspace'
import { isTabKind } from '../shared/tabLayout.schema'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'
import { FIT_DURATION_MS, FIT_PADDING } from './browser.open.place'
import { findNodeRoot } from './nodeRoot'
import { rectOfNode, revealNode, selectOnly } from './nodeReveal'
import {
  activateTab, createGroup, moveToGroup, reconcileWithNodes, renameGroup, toggleGroup, ungroup, useTabLayout,
} from './tabLayout.store'
import { useUnreadIds } from './unread'
import { groupMembers, kindOf, layerRows, nodeTabItems, rangeIds, selectedInOrder, type LayerRow } from './layersPanel.model'
import { GROUP_ID } from './layers.commands'
import LayerRowView, { type DropWhere } from './layersPanel.row'
import './layersPanel.css'

export interface LayersPanelProps {
  nodes: Node[]
  statuses: Record<string, AgentStatus>
  rf: RefObject<ReactFlowInstance | null>
  onCloseNode: (id: string) => void
  onRenameNode: (id: string, title: string) => void
  onAddTerminal: () => void
  onAddAgent: () => void
}

/** Drag payload type: a private MIME so a row dropped on the canvas or a terminal carries no text. */
const DRAG_MIME = 'application/x-webterm-layer'
/** Drop key of the empty space below the last row (= ungrouped, at the end). */
const TAIL = '#tail'

export default function LayersPanel({ nodes, statuses, rf, onCloseNode, onRenameNode, onAddTerminal, onAddAgent }: LayersPanelProps) {
  const { order, groups } = useTabLayout().tabs
  useEffect(() => {
    reconcileWithNodes(nodes.map((n) => ({ id: n.id, kind: kindOf(n) })))
  }, [nodes])

  const unread = useUnreadIds()
  const [filter, setFilter] = useState('')
  const items = useMemo(() => nodeTabItems(nodes, order, statuses, unread), [nodes, order, statuses, unread])
  const rows = useMemo(() => layerRows(items, groups, filter), [items, groups, filter])
  const nodeIds = rows.filter((r) => r.type === 'node').map((r) => r.id)
  const selected = selectedInOrder(nodes, order)
  const selectedSet = new Set(selected)

  const [focusId, setFocusId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; group: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [drop, setDrop] = useState<{ key: string; where: DropWhere | 'end' } | null>(null)
  const [menu, setMenu] = useState<{ row: LayerRow; anchor: { x: number; y: number } } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dragId = useRef<string | null>(null)
  const anchor = useRef<string | null>(null)
  const hovered = useRef<HTMLElement | null>(null)

  // Canvas selection changed: bring the first selected row into view.
  const selKey = selected.join('\n')
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selKey])

  const clearHover = () => { hovered.current?.removeAttribute('data-layer-hover'); hovered.current = null }
  useEffect(() => clearHover, [])
  const hover = (id: string, on: boolean) => {
    clearHover()
    const el = on ? findNodeRoot(id) : undefined
    if (el) { el.setAttribute('data-layer-hover', ''); hovered.current = el }
  }

  const setSelection = (ids: readonly string[]) => {
    const want = new Set(ids)
    rf.current?.setNodes((prev) => prev.map((n) => (!!n.selected === want.has(n.id) ? n : { ...n, selected: want.has(n.id) })))
  }
  const activate = (id: string) => {
    const r = rf.current
    const n = r?.getNode(id)
    if (!r || !n) return
    selectOnly(r, id)
    // Keeps tab mode on the same node when the user switches layouts.
    if (isTabKind(kindOf(n))) activateTab(id)
    revealNode(r, id, rectOfNode(n))
  }
  const activateGroup = (groupId: string) => {
    const r = rf.current
    const members = groupMembers(items, groups.find((g) => g.id === groupId))
    const rects = members.map((id) => r?.getNode(id)).filter((n): n is Node => !!n).map(rectOfNode)
    if (!r || !rects.length) return
    setSelection(members)
    const x = Math.min(...rects.map((b) => b.x))
    const y = Math.min(...rects.map((b) => b.y))
    const width = Math.max(...rects.map((b) => b.x + b.width)) - x
    const height = Math.max(...rects.map((b) => b.y + b.height)) - y
    void r.fitBounds({ x, y, width, height }, { padding: FIT_PADDING, duration: FIT_DURATION_MS })
  }

  const onRowClick = (e: MouseEvent, row: LayerRow) => {
    if (row.type === 'group') return activateGroup(row.id)
    if (row.type !== 'node') return
    if (e.shiftKey) return setSelection(rangeIds(nodeIds, anchor.current, row.id))
    anchor.current = row.id
    if (e.metaKey || e.ctrlKey) setSelection(selectedSet.has(row.id) ? selected.filter((id) => id !== row.id) : [...selected, row.id])
    else activate(row.id)
  }

  const startRename = (row: LayerRow) => {
    if (row.type === 'empty') return
    setDraft(row.type === 'group' ? row.name : row.item.title)
    setEditing({ id: row.id, group: row.type === 'group' })
  }
  // Enter commits, then refocusing the row blurs the input: the ref makes that second commit a no-op.
  const editRef = useRef(editing)
  editRef.current = editing
  const endEdit = () => { editRef.current = null; setEditing(null) }
  const commitRename = () => {
    const edit = editRef.current
    const next = draft.trim()
    endEdit()
    if (edit && next) (edit.group ? renameGroup : onRenameNode)(edit.id, next)
    listRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
  }

  const dropTarget = (row: LayerRow | null): { key: string; where: DropWhere | 'end' } =>
    !row ? { key: TAIL, where: 'end' } : row.type === 'node' ? { key: row.id, where: 'before' } : { key: row.id, where: 'into' }
  const onDragOver = (e: DragEvent, row: LayerRow | null) => {
    if (dragId.current === null) return
    e.preventDefault()
    e.stopPropagation()
    const t = dropTarget(row)
    setDrop((d) => (d && d.key === t.key ? d : t))
  }
  const onDrop = (e: DragEvent, row: LayerRow | null) => {
    const id = dragId.current
    if (id === null) return
    e.preventDefault()
    e.stopPropagation()
    if (!row) moveToGroup(id, null)
    else if (row.type === 'node') { if (row.id !== id) moveToGroup(id, row.groupId, row.id) }
    else moveToGroup(id, row.type === 'group' ? row.id : row.groupId)
    dragId.current = null
    setDrop(null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = rows.findIndex((r) => r.id === (e.target as HTMLElement).dataset.rowId)
    const row = rows[at]
    if (!row) return
    const focusRow = (i: number) => listRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[i]?.focus()
    const k = e.key
    if (k === 'ArrowDown') focusRow(Math.min(at + 1, rows.length - 1))
    else if (k === 'ArrowUp') focusRow(Math.max(at - 1, 0))
    else if (k === 'Home') focusRow(0)
    else if (k === 'End') focusRow(rows.length - 1)
    else if (k === 'ArrowLeft') {
      if (row.type === 'group' && row.expanded) toggleGroup(row.id, true)
      else if (row.type !== 'group' && row.groupId) focusRow(rows.findIndex((r) => r.type === 'group' && r.id === row.groupId))
    } else if (k === 'ArrowRight' && row.type === 'group') {
      if (!row.expanded) toggleGroup(row.id, false)
      else focusRow(at + 1)
    } else if (k === 'Enter') onRowClick(e as unknown as MouseEvent, row)
    else if (k === 'F2') startRename(row)
    else return
    e.preventDefault()
  }

  const menuItems = (row: LayerRow): VscodeMenuItem[] => {
    if (row.type === 'group') {
      return [
        { type: 'item', id: 'rename', label: 'Rename', onSelect: () => startRename(row) },
        { type: 'item', id: 'ungroup', label: 'Ungroup', onSelect: () => ungroup(row.id) },
      ]
    }
    if (row.type !== 'node') return []
    const ids = selectedSet.has(row.id) ? selected : [row.id]
    // Out of the group but in place: just below it (before whatever follows its last member).
    const members = groups.find((g) => g.id === row.groupId)?.ids ?? []
    const lastAt = Math.max(-1, ...members.map((m) => items.findIndex((i) => i.id === m)))
    const after = items[lastAt + 1]?.id ?? null
    return [
      { type: 'item', id: 'group', label: 'Group Selection', onSelect: () => void createGroup(ids) },
      ...(row.groupId ? [{ type: 'item' as const, id: 'ungroup-one', label: 'Remove from Group', onSelect: () => moveToGroup(row.id, null, after) }] : []),
      { type: 'separator' },
      { type: 'item', id: 'rename', label: 'Rename', onSelect: () => startRename(row) },
      { type: 'item', id: 'close', label: 'Close', onSelect: () => onCloseNode(row.id) },
    ]
  }
  const onContextMenu = (e: MouseEvent, row: LayerRow) => {
    if (row.type === 'empty') return
    e.preventDefault()
    if (row.type === 'node' && !selectedSet.has(row.id) && rf.current) selectOnly(rf.current, row.id)
    setMenu({ row, anchor: { x: e.clientX, y: e.clientY } })
  }

  if (!nodes.length) {
    return (
      <div className="layers-panel layers-empty">
        <p>No nodes yet</p>
        <div className="layers-empty__actions">
          <Button size="sm" onClick={onAddTerminal}>New Terminal</Button>
          <Button size="sm" variant="secondary" onClick={onAddAgent}>New Agent</Button>
        </div>
      </div>
    )
  }

  const tabStop = rows.some((r) => r.id === focusId) ? focusId : rows[0]?.id
  return (
    <div className="layers-panel">
      <div className="layers-toolbar">
        <Input
          className="layers-toolbar__filter" placeholder="Filter" aria-label="Filter layers" value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.preventDefault(); setFilter('') } }}
        />
        <IconButton
          label="New Group from Selection" commandId={GROUP_ID} size="icon-sm" side="bottom"
          disabled={!selected.length} disabledReason="Select nodes first" onClick={() => createGroup(selected)}
        ><span className="codicon codicon-new-folder" aria-hidden="true" /></IconButton>
      </div>
      {!rows.length ? (
        <div className="layers-empty">
          <p>No matching nodes</p>
          <Button size="sm" variant="secondary" onClick={() => setFilter('')}>Clear Filter</Button>
        </div>
      ) : (
        <div
          ref={listRef} className="layers-tree nowheel nodrag" role="tree" aria-label="Layers" aria-multiselectable="true"
          onKeyDown={onKeyDown}
          onDragOver={(e) => onDragOver(e, null)} onDrop={(e) => onDrop(e, null)}
        >
          {rows.map((row) => (
            <LayerRowView
              key={row.id} row={row} tabStop={row.id === tabStop}
              selected={row.type === 'node' && selectedSet.has(row.id)}
              drop={drop?.key === row.id && drop.where !== 'end' ? drop.where : undefined}
              editing={editing?.id === row.id ? { draft, setDraft, commit: commitRename, cancel: endEdit } : undefined}
              onClick={(e) => onRowClick(e, row)}
              onDoubleClick={() => startRename(row)}
              onContextMenu={(e) => onContextMenu(e, row)}
              onToggle={() => toggleGroup(row.id)}
              onHover={(on) => { if (row.type === 'node') hover(row.id, on) }}
              onFocus={() => setFocusId(row.id)}
              onDragStart={(e) => { dragId.current = row.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(DRAG_MIME, row.id) }}
              onDragOver={(e) => onDragOver(e, row)}
              onDrop={(e) => onDrop(e, row)}
              onDragEnd={() => { dragId.current = null; setDrop(null) }}
            />
          ))}
          <div className="layers-tree__tail" data-drop={drop?.where === 'end' ? 'end' : undefined} aria-hidden="true" />
        </div>
      )}
      <VscodeMenu
        open={menu !== null} anchor={menu?.anchor ?? { x: 0, y: 0 }} items={menu ? menuItems(menu.row) : []}
        onClose={() => setMenu(null)} ariaLabel="Layer actions"
      />
    </div>
  )
}
