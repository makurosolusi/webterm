// One row of the Layers tree: a node (kind icon, full label, status dot), a group (twisty, folder,
// name, member count) or an empty group's "Drag nodes here" child. Behaviour lives in the panel;
// a row only renders and forwards events.
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { NodeNameLabel, withNodeName } from './nodeName.label'
import type { LayerRow } from './layersPanel.model'

export type DropWhere = 'before' | 'into'

export interface RowEditing { draft: string; setDraft: (v: string) => void; commit: () => void; cancel: () => void }

export interface LayerRowProps {
  row: LayerRow
  selected: boolean
  tabStop: boolean
  drop?: DropWhere
  editing?: RowEditing
  onClick: (e: MouseEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void
  onToggle: () => void
  onHover: (on: boolean) => void
  onFocus: () => void
  onDragStart: (e: DragEvent<HTMLDivElement>) => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

function EditBox({ editing, label }: { editing: RowEditing; label: string }) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') { e.preventDefault(); editing.commit() }
    else if (e.key === 'Escape') { e.preventDefault(); editing.cancel() }
  }
  return (
    <Input
      autoFocus className="layers-row__edit" aria-label={label} value={editing.draft}
      onChange={(e) => editing.setDraft(e.target.value)} onKeyDown={onKey} onBlur={editing.commit}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onFocus={(e) => e.currentTarget.select()}
    />
  )
}

export default function LayerRowView(p: LayerRowProps) {
  const { row } = p
  const full = row.type === 'node' ? withNodeName(row.item.name, row.item.title) : row.type === 'group' ? row.name : undefined
  return (
    <div
      role="treeitem" aria-level={row.level} aria-selected={p.selected}
      aria-expanded={row.type === 'group' ? row.expanded : undefined}
      aria-disabled={row.type === 'empty' ? true : undefined}
      tabIndex={p.tabStop ? 0 : -1} data-row-id={row.id} data-drop={p.drop}
      className={cn('layers-row', `layers-row--${row.type}`, p.selected && 'layers-row--selected')}
      style={{ paddingLeft: 4 + (row.level - 1) * 16 }}
      title={p.editing ? undefined : full}
      draggable={row.type === 'node' && !p.editing}
      onClick={p.onClick} onDoubleClick={p.onDoubleClick} onContextMenu={p.onContextMenu} onFocus={p.onFocus}
      onMouseEnter={() => p.onHover(true)} onMouseLeave={() => p.onHover(false)}
      onDragStart={p.onDragStart} onDragOver={p.onDragOver} onDrop={p.onDrop} onDragEnd={p.onDragEnd}
    >
      {row.type === 'group' ? (
        <span
          className={cn('layers-row__twisty codicon', row.expanded ? 'codicon-chevron-down' : 'codicon-chevron-right')}
          aria-hidden="true" data-twisty=""
          onClick={(e) => { e.stopPropagation(); p.onToggle() }}
        />
      ) : <span className="layers-row__twisty" aria-hidden="true" />}
      {row.type === 'empty' ? <span className="layers-row__hint">Drag nodes here</span> : (
        <>
          <span
            className={cn('layers-row__icon codicon', row.type === 'node' ? `codicon-${row.item.icon}` : row.expanded ? 'codicon-folder-opened' : 'codicon-folder')}
            aria-hidden="true"
          />
          {p.editing ? <EditBox editing={p.editing} label={row.type === 'group' ? 'Rename group' : 'Rename node'} /> : (
            <span className="layers-row__label">
              {row.type === 'node' ? <NodeNameLabel name={row.item.name} label={row.item.title} /> : row.name}
            </span>
          )}
          {row.type === 'group' && <span className="layers-row__count" aria-label={`${row.count} nodes`}>{row.count}</span>}
          {row.type === 'node' && row.item.signal && (
            <span className={cn('layers-row__status', `layers-row__status--${row.item.signal.tone}`)} role="img" aria-label={row.item.signal.label} />
          )}
        </>
      )}
    </div>
  )
}
