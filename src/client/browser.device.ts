// Device mode on the client: text, and the session the surface uses while a device is active. The canvas is letterboxed
// to the device aspect (browser.device.css), so pointer mapping only needs the device's CSS size as the page viewport:
// `toPagePoint` scales the letterboxed canvas rect onto it. Node resizes still reach the server, which ignores them.
import { useRef } from 'react'
import type { CSSProperties } from 'react'
import type { DeviceSpec } from '../shared/browser.devices'
import type { Viewport } from './browser.input'
import type { BrowserSession } from './browser.useSession'

export const DEVICE_TEXT = {
  button: 'Device mode',
  tipOff: 'Device mode: Responsive (page follows the node size). Click to emulate a phone, tablet or desktop',
  tipOn: (name: string) => `Device mode: ${name}. Click to change device`,
  picker: 'Choose a device',
  responsive: 'Responsive',
  custom: 'Custom',
  width: 'Width', height: 'Height', dpr: 'Pixel ratio',
  apply: 'Apply',
  invalid: (min: number, max: number, dprMin: number, dprMax: number) =>
    `Width and height must be whole numbers from ${min} to ${max}; pixel ratio from ${dprMin} to ${dprMax}.`,
  rotate: 'Rotate',
  rotateTip: 'Rotate: swap portrait and landscape',
} as const

/** Session for the surface: in device mode its page viewport is the device size instead of the node size. */
export function useDeviceSession(session: BrowserSession, device: DeviceSpec | null): BrowserSession {
  const vp = useRef<Viewport | null>(null)
  vp.current = device ? { w: device.w, h: device.h } : null
  return device ? { ...session, viewport: vp } : session
}

/** CSS variables that size the letterboxed canvas (browser.device.css). */
export function deviceStyle(device: DeviceSpec | null): CSSProperties {
  return device ? ({ '--device-w': device.w, '--device-h': device.h } as CSSProperties) : {}
}
