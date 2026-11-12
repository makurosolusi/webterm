// Tab mode hides the node frame header (the tab is the header), so its actions move to the tab
// strip like VS Code: the active tab's "editor actions" at the strip's right end, and the same
// rows in the tab's context menu. The node's own NodeChrome renders the editor actions through a
// portal into the strip's slot (so they keep the node's React context) and publishes its menu rows
// here for the strip to read when a tab's context menu opens.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { Button } from '@/components/ui/button'
import { VscodeMenu, type VscodeMenuItem } from './components/vscode/vscodeMenu'

let slot: HTMLElement | null = null
const slotSubs = new Set<() => void>()
const subscribeSlot = (f: () => void) => { slotSubs.add(f); return () => { slotSubs.delete(f) } }

/** The strip's editor-actions element (ref callback of TabsView). */
export function setEditorActionsSlot(el: HTMLElement | null): void {
  if (slot === el) return
  slot = el
  slotSubs.forEach((f) => f())
}

const menus = new Map<string, VscodeMenuItem[]>()

// Tabs whose node has unsaved changes (the strip shows a dot in place of the ×, like VS Code).
// Replaced, not mutated, so `useSyncExternalStore` sees a new snapshot.
let dirtyIds: ReadonlySet<string> = new Set()
const dirtySubs = new Set<() => void>()
const subscribeDirty = (f: () => void) => { dirtySubs.add(f); return () => { dirtySubs.delete(f) } }
function publishDirty(id: string, dirty: boolean): void {
  if (dirtyIds.has(id) === dirty) return
  const next = new Set(dirtyIds)
  if (dirty) next.add(id)
  else next.delete(id)
  dirtyIds = next
  dirtySubs.forEach((f) => f())
}

/** Ids of tabs whose node published unsaved changes. */
export const useDirtyTabs = (): ReadonlySet<string> => useSyncExternalStore(subscribeDirty, () => dirtyIds, () => dirtyIds)

/** Context-menu rows of a tab's node, read when the menu opens. */
export const tabNodeMenuItems = (id: string): VscodeMenuItem[] => menus.get(id) ?? []

export interface TabNodeActionsProps {
  /** Node id; null outside a flow (nothing is published). */
  id: string | null
  /** Active tab: only it shows editor actions. */
  visible: boolean
  /** Rows of the node's "More Actions…" menu (`nodeMoreItems`). */
  items: VscodeMenuItem[]
  search?: { open: boolean; toggle: () => void }
  onStop?: () => void
  /** Node-specific header widgets (usage pill, view switch). */
  extra?: ReactNode
  /** Node-specific actions (Save, Preview, Refresh…): a strip button each, and a context-menu row. */
  actions?: TabAction[]
  /** Unsaved changes: the node's tab shows the dirty dot. */
  dirty?: boolean
}

/** One node action shown in the strip (icon → icon button, else a text button) and in the tab menu. */
export interface TabAction {
  id: string
  /** Button text (or accessible name of an icon button) and menu row label. */
  label: string
  /** Tooltip when it says more than `label`. */
  tooltip?: string
  /** Codicon name: an icon button instead of a text button. */
  icon?: string
  disabled?: boolean
  /** Running: the button reads `aria-busy` (its label says what runs, e.g. "Saving…"). */
  busy?: boolean
  /** Toggle state (Preview, Word wrap). */
  checked?: boolean
  /** The primary action of the node (Approve and run); others are secondary. */
  primary?: boolean
  onSelect: () => void
}

function StripAction({ a }: { a: TabAction }) {
  const common = { disabled: a.disabled, 'aria-busy': a.busy ? true : undefined, 'aria-pressed': a.checked, onClick: a.onSelect }
  if (a.icon) {
    return (
      <IconButton label={a.label} tooltip={a.tooltip} side="bottom" size="icon-sm" {...common}>
        <span className={`codicon codicon-${a.icon}`} aria-hidden="true" />
      </IconButton>
    )
  }
  return (
    <IconTooltip label={a.tooltip ?? a.label} side="bottom" disabled={a.disabled}>
      <Button variant={a.primary ? 'default' : 'secondary'} size="xs" {...common}>{a.label}</Button>
    </IconTooltip>
  )
}

/** Publishes the node's menu rows and, for the active tab, renders its editor actions into the strip. */
export default function TabNodeActions({ id, visible, items, search, onStop, extra, actions = [], dirty = false }: TabNodeActionsProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const target = useSyncExternalStore(subscribeSlot, () => slot, () => null)
  const all: VscodeMenuItem[] = [
    ...(search ? [{ type: 'item', id: 'search', label: 'Search', checked: search.open, onSelect: search.toggle } as const, { type: 'separator' } as const] : []),
    ...actions.map((a): VscodeMenuItem => ({ type: 'item', id: a.id, label: a.label, title: a.tooltip, disabled: a.disabled, checked: a.checked, onSelect: a.onSelect })),
    ...(actions.length && items.length ? [{ type: 'separator' } as const] : []),
    ...items,
    ...(onStop ? [{ type: 'separator' } as const, { type: 'item', id: 'stop', label: 'Stop Agent (keeps the node)', onSelect: onStop } as const] : []),
  ]
  useEffect(() => {
    if (!id) return
    menus.set(id, all)
    return () => { menus.delete(id) }
  })
  useEffect(() => {
    if (!id) return
    publishDirty(id, dirty)
    return () => publishDirty(id, false)
  }, [id, dirty])
  if (!visible || !target) return null
  return createPortal(
    <>
      {extra}
      {actions.map((a) => <StripAction key={a.id} a={a} />)}
      {search && (
        <IconButton label="Search" side="bottom" size="icon-sm" aria-pressed={search.open} onClick={search.toggle}>
          <span className="codicon codicon-search" aria-hidden="true" />
        </IconButton>
      )}
      {onStop && (
        <IconButton label="Stop Agent (keeps the node)" side="bottom" size="icon-sm" className="tabs-strip__stop" onClick={onStop}>
          <span className="codicon codicon-debug-stop" aria-hidden="true" />
        </IconButton>
      )}
      {items.length > 0 && (
        <IconButton
          label="More Actions…" side="bottom" size="icon-sm"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt({ x: r.left, y: r.bottom }) }}
        ><span className="codicon codicon-ellipsis" aria-hidden="true" /></IconButton>
      )}
      {menuAt && <VscodeMenu open anchor={menuAt} items={items} onClose={() => setMenuAt(null)} ariaLabel="More Actions" />}
    </>,
    target,
  )
}
