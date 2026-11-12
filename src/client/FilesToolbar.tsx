// Files node title-bar actions, VS Code Explorer order: New File, New Folder, Refresh, Collapse All, then
// a "…" overflow menu holding the view options (hidden files, sort) and the slot rows (Upload).
// Options persist through `viewOpts` (owned by FilesNode); this component only reports changes.
import { useState, type MouseEvent } from 'react'
import type { ViewOpts } from '../shared/workspace'
import { IconTooltip } from './components/ui/icon-button'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'
import { fromSlot } from './FilesMenu'
import { FILES_SLOTS, type FilesSlotCtx } from './filesSlots'
import { TREE_TEXT } from './filesSlot.tree'

interface Props {
  view: ViewOpts
  onChange: (next: ViewOpts) => void
  ctx: FilesSlotCtx
  /** New File (false) / New Folder (true): inline name input in the tree. */
  onNew: (dir: boolean) => void
  onRefresh: () => void
}

export const TOOLBAR_TEXT = {
  newFile: 'New File…',
  newFolder: 'New Folder…',
  refresh: 'Refresh Explorer',
  collapseAll: TREE_TEXT.collapseAll,
  more: 'More Actions…',
  showHidden: 'Show Hidden Files',
} as const

const KEYS: { key: ViewOpts['sortKey']; label: string }[] = [
  { key: 'name', label: 'Sort by Name' },
  { key: 'size', label: 'Sort by Size' },
  { key: 'mtime', label: 'Sort by Modified' },
]

function Tool({ label, icon, onClick, disabled, menu }: { label: string; icon: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; menu?: boolean }) {
  return (
    <IconTooltip label={label}>
      <button type="button" className="files-tool" aria-label={label} aria-haspopup={menu ? 'menu' : undefined} disabled={disabled} onClick={onClick}>
        <span className={`codicon codicon-${icon}`} aria-hidden="true" />
      </button>
    </IconTooltip>
  )
}

/** Overflow menu rows: view toggles (checkmarks), sort, then slot rows. */
export function overflowItems(view: ViewOpts, onChange: (v: ViewOpts) => void, ctx: FilesSlotCtx): VscodeMenuItem[] {
  const check = (id: string, label: string, checked: boolean, next: ViewOpts): VscodeMenuItem =>
    ({ type: 'item', id, label, checked, onSelect: () => onChange(next) })
  const slots = fromSlot(FILES_SLOTS.flatMap((s) => s.overflow?.(ctx) ?? []), 1)
  return [
    check('hidden', TOOLBAR_TEXT.showHidden, !view.hidden, { ...view, hidden: !view.hidden }),
    { type: 'separator' },
    ...KEYS.map(({ key, label }) => check(key, label, view.sortKey === key, { ...view, sortKey: key })),
    { type: 'separator' },
    check('asc', 'Ascending', view.sortDir === 'asc', { ...view, sortDir: 'asc' }),
    check('desc', 'Descending', view.sortDir === 'desc', { ...view, sortDir: 'desc' }),
    ...(slots.length ? [{ type: 'separator' } as VscodeMenuItem, ...slots] : []),
  ]
}

export default function FilesToolbar({ view, onChange, ctx, onNew, onRefresh }: Props) {
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <div className="files-toolbar nodrag">
      <Tool label={TOOLBAR_TEXT.newFile} icon="new-file" onClick={() => onNew(false)} />
      <Tool label={TOOLBAR_TEXT.newFolder} icon="new-folder" onClick={() => onNew(true)} />
      <Tool label={TOOLBAR_TEXT.refresh} icon="refresh" onClick={onRefresh} />
      <Tool label={TOOLBAR_TEXT.collapseAll} icon="collapse-all" disabled={ctx.expanded.size === 0} onClick={() => ctx.collapseAll()} />
      <Tool
        label={TOOLBAR_TEXT.more} icon="ellipsis" menu
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMoreAt({ x: r.left, y: r.bottom }) }}
      />
      {moreAt && (
        <VscodeMenu open anchor={moreAt} items={overflowItems(view, onChange, ctx)} onClose={() => setMoreAt(null)} ariaLabel={TOOLBAR_TEXT.more} />
      )}
    </div>
  )
}
