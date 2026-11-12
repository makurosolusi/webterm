// Tab mode hides the node frame header (the tab is the header), so its actions move to the tab
// strip like VS Code: the active tab's "editor actions" at the strip's right end, and the same
// rows in the tab's context menu. The node's own NodeChrome renders the editor actions through a
// portal into the strip's slot (so they keep the node's React context) and publishes its menu rows
// here for the strip to read when a tab's context menu opens.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '@/components/ui/icon-button'
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
}

/** Publishes the node's menu rows and, for the active tab, renders its editor actions into the strip. */
export default function TabNodeActions({ id, visible, items, search, onStop, extra }: TabNodeActionsProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const target = useSyncExternalStore(subscribeSlot, () => slot, () => null)
  const all: VscodeMenuItem[] = [
    ...(search ? [{ type: 'item', id: 'search', label: 'Search', checked: search.open, onSelect: search.toggle } as const, { type: 'separator' } as const] : []),
    ...items,
    ...(onStop ? [{ type: 'separator' } as const, { type: 'item', id: 'stop', label: 'Stop Agent (keeps the node)', onSelect: onStop } as const] : []),
  ]
  useEffect(() => {
    if (!id) return
    menus.set(id, all)
    return () => { menus.delete(id) }
  })
  if (!visible || !target) return null
  return createPortal(
    <>
      {extra}
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
      <IconButton
        label="More Actions…" side="bottom" size="icon-sm"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt({ x: r.left, y: r.bottom }) }}
      ><span className="codicon codicon-ellipsis" aria-hidden="true" /></IconButton>
      {menuAt && <VscodeMenu open anchor={menuAt} items={items} onClose={() => setMenuAt(null)} ariaLabel="More Actions" />}
    </>,
    target,
  )
}
