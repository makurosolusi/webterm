// Thin header of one pane: which tab it shows (click = pick another), its size, device menu, Close pane. The header is also
// the grip for swapping two panes (drag it onto another pane).
import { useState } from 'react'
import type { PointerEvent } from 'react'
import { Smartphone, X } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from '@/components/vscode/vscodeMenu'
import type { VscodeMenuItem } from '@/components/vscode/vscodeMenu'
import { resolveDevice } from '../../shared/browser.devices'
import type { DeviceChoice } from '../../shared/browser.devices'
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
}

type Open = { kind: 'tabs' | 'device'; at: { x: number; y: number } } | null

export function BrowserPaneHeader({ tab, tabs, shown, focused, size, onPick, onDevice, onClose, onGrip }: BrowserPaneHeaderProps) {
  const [open, setOpen] = useState<Open>(null)
  const device = tab.device ?? null
  const spec = resolveDevice(device)
  const anchor = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom } }

  const items: VscodeMenuItem[] = open?.kind === 'tabs'
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

  return (
    <div className={`bp-head nodrag${focused ? ' bp-head--focus' : ''}`} onPointerDown={onGrip} data-pane-grip>
      <button
        type="button" className="bp-title" aria-haspopup="menu" aria-expanded={open?.kind === 'tabs'} title={tabTooltip(tab)}
        onClick={(e) => setOpen({ kind: 'tabs', at: anchor(e.currentTarget) })}
      >
        <BrowserTabIcon tab={tab} />
        <span className="bp-title__text">{tabTitle(tab)}</span>
      </button>
      <span className="bp-size" aria-label="Page size" data-testid="pane-size">{sizeIndicator(device, size)}</span>
      <IconButton
        label={deviceButtonLabel(device)} size="icon-xs" aria-haspopup="menu" aria-pressed={!!spec} data-pane-device
        onClick={(e) => setOpen({ kind: 'device', at: anchor(e.currentTarget) })}
      >
        <Smartphone aria-hidden="true" />
      </IconButton>
      <IconButton label="Close pane" size="icon-xs" onClick={onClose}><X aria-hidden="true" /></IconButton>
      {open && <VscodeMenu open anchor={open.at} items={items} onClose={() => setOpen(null)} ariaLabel={open.kind === 'tabs' ? 'Tab in this pane' : 'Device for this pane'} />}
    </div>
  )
}
