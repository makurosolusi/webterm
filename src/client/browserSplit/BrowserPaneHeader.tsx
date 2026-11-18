// Thin header of one pane: which tab it shows (click = pick another), its size, device menu, Close pane. The header is also
// the grip for swapping two panes (drag it onto another pane).
import { useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { GripVertical, Smartphone, X } from 'lucide-react'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import { resolveDevice } from '../../shared/browser.devices'
import type { DeviceChoice } from '../../shared/browser.devices'
import type { Direction } from '../../shared/browser.layout'
import type { BrowserTab } from '../../shared/browser.tabs'
import { BrowserTabIcon } from '../browserTabs/BrowserTabIcon'
import { tabTitle, tabTooltip } from '../browserTabs/browserTabs.labels'
import { QUICK_SIZES, RESPONSIVE_LABEL, deviceButtonLabel, quickSizeOf, sizeIndicator } from './browserSplit.devices'

export interface BrowserPaneHeaderProps {
  tab: BrowserTab
  tabs: BrowserTab[]
  /** Tab ids shown in some pane (a tab picked here that is shown elsewhere swaps places with it). */
  shown: string[]
  focused: boolean
  size: { w: number; h: number } | null
  onPick: (tabId: string) => void
  onDevice: (d: DeviceChoice | null) => void
  onClose: () => void
  onGrip: (e: PointerEvent) => void
  /** Moving the pane without a pointer: Alt+Shift+Arrow and the header's context menu. */
  moves: { can: (dir: Direction) => boolean; run: (dir: Direction) => void; swapWith: (tabId: string) => void; wasDragged: () => boolean }
}

const MOVES: Array<{ dir: Direction; label: string }> = [
  { dir: 'left', label: 'Move pane left' }, { dir: 'right', label: 'Move pane right' }, { dir: 'up', label: 'Move pane up' }, { dir: 'down', label: 'Move pane down' },
]
const ARROW_DIR: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

type Open = { kind: 'tabs' | 'device' | 'move'; at: { x: number; y: number } } | null

export function BrowserPaneHeader({ tab, tabs, shown, focused, size, onPick, onDevice, onClose, onGrip, moves }: BrowserPaneHeaderProps) {
  const [open, setOpen] = useState<Open>(null)
  const device = tab.device ?? null
  const spec = resolveDevice(device)
  const anchor = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom } }

  const others = tabs.filter((t) => t.tabId !== tab.tabId && shown.includes(t.tabId))
  const items: VscodeMenuItem[] = open?.kind === 'move'
    ? [
      ...MOVES.map((m): VscodeMenuItem => ({ type: 'item', id: m.dir, label: m.label, disabled: !moves.can(m.dir), title: moves.can(m.dir) ? undefined : 'No pane that way', onSelect: () => moves.run(m.dir) })),
      ...(others.length ? [{ type: 'separator' } as const] : []),
      ...others.map((t): VscodeMenuItem => ({ type: 'item', id: `swap-${t.tabId}`, label: `Swap with ${tabTitle(t)}`, onSelect: () => moves.swapWith(t.tabId) })),
    ]
    : open?.kind === 'tabs'
    ? tabs.map((t) => ({
      type: 'item' as const, id: t.tabId, label: tabTitle(t), checked: t.tabId === tab.tabId,
      title: t.tabId !== tab.tabId && shown.includes(t.tabId) ? 'Shown in another pane: the two panes swap' : undefined, onSelect: () => onPick(t.tabId),
    }))
    : [
      { type: 'item', id: 'responsive', label: RESPONSIVE_LABEL, checked: !spec, onSelect: () => onDevice(null) },
      { type: 'separator' },
      ...QUICK_SIZES.map((q): VscodeMenuItem => ({
        type: 'item', id: q.id, label: `${q.label} ${q.width}`, checked: quickSizeOf(device)?.id === q.id, onSelect: () => onDevice(q.choice),
      })),
      ...(spec ? [{ type: 'separator' } as const, { type: 'item', id: 'rotate', label: 'Rotate', checked: spec.landscape, onSelect: () => onDevice({ ...(device as DeviceChoice), landscape: !spec.landscape }) } as const] : []),
    ]

  const onKeyDown = (e: KeyboardEvent) => {
    const dir = ARROW_DIR[e.key]
    if (!(e.altKey && e.shiftKey && dir) || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation() // not the page's, not the node's
    moves.run(dir)
  }

  return (
    <div
      className={`bp-head nodrag nopan${focused ? ' bp-head--focus' : ''}`} onPointerDown={onGrip} onKeyDown={onKeyDown} data-pane-grip
      onContextMenu={(e) => { e.preventDefault(); setOpen({ kind: 'move', at: { x: e.clientX, y: e.clientY } }) }}
    >
      <IconTooltip label="Drag to move or swap pane">
        <span className="bp-grip" data-pane-grip-handle aria-hidden="true"><GripVertical /></span>
      </IconTooltip>
      <IconTooltip label={tabTooltip(tab)}>
        <button
          type="button" className="bp-title" data-pane-title aria-haspopup="menu" aria-expanded={open?.kind === 'tabs'} aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
          onClick={(e) => { if (!moves.wasDragged()) setOpen({ kind: 'tabs', at: anchor(e.currentTarget) }) }}
        >
          <BrowserTabIcon tab={tab} />
          <span className="bp-title__text">{tabTitle(tab)}</span>
        </button>
      </IconTooltip>
      <span className="bp-size" aria-label="Page size" data-testid="pane-size">{sizeIndicator(device, size)}</span>
      <IconButton
        label={deviceButtonLabel(device)} size="icon-bui" aria-haspopup="menu" aria-pressed={!!spec} data-pane-device
        onClick={(e) => setOpen({ kind: 'device', at: anchor(e.currentTarget) })}
      >
        <Smartphone aria-hidden="true" />
      </IconButton>
      <IconButton label="Close pane" size="icon-bui" onClick={onClose}><X aria-hidden="true" /></IconButton>
      {open && <VscodeMenu open anchor={open.at} items={items} onClose={() => setOpen(null)} ariaLabel={open.kind === 'tabs' ? 'Tab in this pane' : open.kind === 'move' ? 'Move pane' : 'Device for this pane'} />}
    </div>
  )
}
