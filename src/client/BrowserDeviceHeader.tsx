// Strip above a device-mode browser: "iPhone 15 Pro · 393×852 · 3x" and a rotate button (DevTools Device Toolbar).
import { IconButton } from '@/components/ui/icon-button'
import { deviceLabel } from '../shared/browser.devices'
import type { DeviceSpec } from '../shared/browser.devices'
import { DEVICE_TEXT } from './browser.device'
import './browser.device.css'

/** Shown only while a device is active; `onRotate` swaps portrait/landscape. */
export default function BrowserDeviceHeader({ device, onRotate }: { device: DeviceSpec | null; onRotate: () => void }) {
  if (!device) return null
  return (
    <div className="browser-device-header nodrag">
      <span>{deviceLabel(device)}</span>
      <IconButton size="icon-xs" label={DEVICE_TEXT.rotate} tooltip={DEVICE_TEXT.rotateTip} aria-pressed={device.landscape} onClick={onRotate}>
        <span className="codicon codicon-sync" aria-hidden="true" />
      </IconButton>
    </div>
  )
}
