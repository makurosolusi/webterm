// Toolbar "Device mode" button + compact picker: Responsive, the presets, or a Custom size (DevTools Device Toolbar).
import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import {
  DEVICE_CUSTOM, DEVICE_DIM_MAX, DEVICE_DIM_MIN, DEVICE_DPR_MAX, DEVICE_DPR_MIN, DEVICE_PRESETS, parseDeviceChoice, resolveDevice,
} from '../shared/browser.devices'
import type { DeviceChoice } from '../shared/browser.devices'
import { VscodePopover } from './components/vscode/vscodePopover'
import { DEVICE_TEXT as T } from './browser.device'
import './browser.device.css'

const CUSTOM_DEFAULT = { w: '400', h: '800', dpr: '2' }

export interface BrowserDevicePickerProps {
  value?: DeviceChoice
  /** null = Responsive. */
  onChange: (device: DeviceChoice | null) => void
}

/** The picker list on its own, anchored to any element (the toolbar's ⋯ menu opens it via "Device mode…"). */
export function BrowserDevicePopover({ anchor, value, onChange, onClose }: BrowserDevicePickerProps & { anchor: HTMLElement; onClose: () => void }) {
  const current = resolveDevice(value)
  const custom = value?.id === DEVICE_CUSTOM ? { w: String(value.w), h: String(value.h), dpr: String(value.dpr) } : CUSTOM_DEFAULT
  const [draft, setDraft] = useState(custom)
  const [error, setError] = useState(false)
  const landscape = value?.landscape ? { landscape: true } : {}
  const pick = (d: DeviceChoice | null) => { onChange(d); onClose() }

  const applyCustom = (e: FormEvent) => {
    e.preventDefault()
    const c = parseDeviceChoice({ id: DEVICE_CUSTOM, w: Number(draft.w), h: Number(draft.h), dpr: Number(draft.dpr), ...landscape })
    if (!c) { setError(true); return }
    setError(false)
    pick(c)
  }
  const field = (k: keyof typeof draft, label: string) => (
    <Input type="number" aria-label={label} placeholder={label} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
  )

  return (
    <VscodePopover anchor={anchor} open onOpenChange={(o) => { if (!o) onClose() }} ariaLabel={T.picker} className="browser-device-pop">
      <Button size="bui" variant="ghost" aria-pressed={current === null} onClick={() => pick(null)}>{T.responsive}</Button>
      {DEVICE_PRESETS.map((p) => (
        <Button key={p.id} size="bui" variant="ghost" aria-pressed={current?.id === p.id} onClick={() => pick({ id: p.id, ...landscape })}>
          <span>{p.name}</span><span className="tabular-nums opacity-70">{p.w}×{p.h}</span>
        </Button>
      ))}
      <form className="browser-device-custom" aria-label={T.custom} onSubmit={applyCustom}>
        {field('w', T.width)}{field('h', T.height)}{field('dpr', T.dpr)}
        <Button type="submit" size="bui" variant="secondary" className="col-span-3">{T.custom}: {T.apply}</Button>
        {error && <p role="alert" className="col-span-3 m-0 text-xs text-(--vscode-errorForeground)">{T.invalid(DEVICE_DIM_MIN, DEVICE_DIM_MAX, DEVICE_DPR_MIN, DEVICE_DPR_MAX)}</p>}
      </form>
    </VscodePopover>
  )
}

/** Standalone button + picker. Picking keeps the current orientation; the popover closes after a choice. */
export default function BrowserDevicePicker({ value, onChange }: BrowserDevicePickerProps) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const current = resolveDevice(value)
  return (
    <span ref={anchor} className="inline-flex">
      <IconButton
        size="icon-bui" label={T.button} aria-pressed={current !== null} aria-expanded={open}
        tooltip={current ? T.tipOn(current.name) : T.tipOff}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="codicon codicon-device-mobile" aria-hidden="true" />
      </IconButton>
      {open && anchor.current && <BrowserDevicePopover anchor={anchor.current} value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </span>
  )
}
