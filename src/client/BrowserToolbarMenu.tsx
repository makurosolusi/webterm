// "⋮" menu at the end of the browser toolbar (Chrome's kebab): zoom, device mode, Shields, Design Mode, console,
// copy/open URL, agent control and the caller's extra rows (Import Cookies). The node has no other page-actions menu;
// the header's "…" holds node actions only. Rarely used controls live here so the row stays one line.
import { useRef, useState } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { VscodeMenu } from './components/vscode/vscodeMenu'
import type { VscodeMenuItem } from './components/vscode/vscodeMenu'
import { VscodePopover } from './components/vscode/vscodePopover'
import type { BrowserState } from '../shared/browser.contract'
import type { DeviceChoice } from '../shared/browser.devices'
import { BrowserDevicePopover } from './BrowserDevicePicker'
import BrowserAgentOffer from './browser.agentOffer'
import { writeClipboard } from './browser.clipboard'
import { zoomLabel } from './browser.zoom'
import { AGENT_OFFER_TEXT, TOOLBAR_MENU_TEXT as M, TOOLBAR_TEXT, TOOLBAR_TIP, ZOOM_TEXT } from './browser.uxText'
import type { DesignMode } from './browser/design/useDesignMode'
import { CONSOLE_TEXT } from './BrowserConsole'
import type { ConsoleSlot } from './BrowserConsole'
import { DL_TEXT } from './browserDownloads/browserDownloads.text'

export interface BrowserToolbarMenuProps {
  state?: BrowserState
  zoom: number
  onZoom?: (dir: -1 | 1) => void
  onZoomReset: () => void
  device?: DeviceChoice
  onDevice?: (device: DeviceChoice | null) => void
  onShields?: (on: boolean) => void
  design?: DesignMode
  agentControl: boolean
  agentEnabled: boolean
  onAgentControl: (enabled: boolean) => void
  onEnableAgent?: () => Promise<void>
  console?: ConsoleSlot
  /** Opens the downloads list (row shown only when given); the only way in while the toolbar button is hidden. */
  onDownloads?: () => void
  /** Reports a failed action (e.g. clipboard) in the toolbar's alert line. */
  onError: (message: string) => void
  /** Rows appended after a separator (browser-wide actions such as Import Cookies). */
  extraItems?: VscodeMenuItem[]
}

/** Display form of the console chord (Chrome's ⌥⌘J), static like the menu's other hints. */
const CONSOLE_KEY = '⌥⌘J'

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />

/** The ⋮ button, its menu, and the popovers a row opens (device picker, agent offer) anchored to the button. */
export default function BrowserToolbarMenu(p: BrowserToolbarMenuProps) {
  const btn = useRef<HTMLSpanElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [pop, setPop] = useState<'device' | 'agent' | null>(null)
  const url = p.state?.url ?? ''
  const shieldsKnown = p.state?.shieldsOff !== undefined

  const items: VscodeMenuItem[] = []
  if (p.onZoom) {
    const onZoom = p.onZoom
    items.push(
      { type: 'item', id: 'zoom-out', label: ZOOM_TEXT.out, icon: icon('zoom-out'), onSelect: () => onZoom(-1) },
      { type: 'item', id: 'zoom-reset', label: M.zoomReset(zoomLabel(p.zoom)), disabled: p.zoom === 1, onSelect: p.onZoomReset },
      { type: 'item', id: 'zoom-in', label: ZOOM_TEXT.in, icon: icon('zoom-in'), onSelect: () => onZoom(1) },
      { type: 'separator' },
    )
  }
  if (p.onDevice) items.push({ type: 'item', id: 'device', label: M.device, icon: icon('device-mobile'), onSelect: () => setPop('device') })
  if (p.onShields && shieldsKnown) {
    const onShields = p.onShields
    const off = p.state?.shieldsOff === true
    items.push({ type: 'item', id: 'shields', label: M.shields, checked: !off, onSelect: () => onShields(off) })
  }
  if (p.design) {
    const design = p.design
    items.push({ type: 'item', id: 'design', label: M.design, checked: design.on, disabled: design.busy, onSelect: () => void design.toggle() })
  }
  if (p.console) {
    const c = p.console
    items.push({ type: 'item', id: 'console', label: CONSOLE_TEXT.toggle, checked: c.open, keybinding: CONSOLE_KEY, onSelect: c.toggle })
  }
  if (p.onDownloads) items.push({ type: 'item', id: 'downloads', label: DL_TEXT.button, icon: icon('download'), onSelect: p.onDownloads })
  if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
  items.push(
    { type: 'item', id: 'copy-url', label: M.copyUrl, icon: icon('copy'), disabled: !url, onSelect: () => {
      void writeClipboard(url).then((r) => { if (!r.ok) { console.warn('browser.copyUrl failed', r.error); p.onError(M.copyFailed) } })
    } },
    { type: 'item', id: 'open-external', label: M.openExternal, icon: icon('link-external'), disabled: !url, onSelect: () => { window.open(url, '_blank', 'noopener') } },
  )
  if (p.agentEnabled) {
    items.push({ type: 'separator' }, { type: 'item', id: 'agent', label: TOOLBAR_TEXT.agentControl, checked: p.agentControl, onSelect: () => p.onAgentControl(!p.agentControl) })
  } else if (p.onEnableAgent) {
    items.push({ type: 'separator' }, { type: 'item', id: 'agent-offer', label: M.agentOffer, onSelect: () => setPop('agent') })
  }
  if (p.extraItems?.length) items.push({ type: 'separator' }, ...p.extraItems)

  return (
    <span ref={btn} className="inline-flex">
      <IconButton
        size="icon-bui" label={TOOLBAR_TEXT.more} tooltip={TOOLBAR_TIP.more} aria-haspopup="menu" aria-expanded={menuAt !== null}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuAt(menuAt ? null : { x: r.right - 200, y: r.bottom }) }}
      >{icon('kebab-vertical')}</IconButton>
      {menuAt && <VscodeMenu open anchor={menuAt} items={items} minWidth={200} onClose={() => setMenuAt(null)} ariaLabel={TOOLBAR_TEXT.menu} />}
      {pop === 'device' && p.onDevice && btn.current && (
        <BrowserDevicePopover anchor={btn.current} value={p.device} onChange={p.onDevice} onClose={() => setPop(null)} />
      )}
      {pop === 'agent' && !p.agentEnabled && p.onEnableAgent && btn.current && (
        <VscodePopover anchor={btn.current} open onOpenChange={(o) => { if (!o) setPop(null) }} ariaLabel={AGENT_OFFER_TEXT.offer}>
          <BrowserAgentOffer enable={p.onEnableAgent} />
        </VscodePopover>
      )}
    </span>
  )
}
