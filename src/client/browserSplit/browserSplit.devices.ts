// Quick device sizes of a pane (Responsively / DevTools device toolbar): one tap for the widths QC compares most.
import { deviceLabel, resolveDevice } from '../../shared/browser.devices'
import type { DeviceChoice } from '../../shared/browser.devices'

export interface QuickSize { id: string; label: string; /** CSS px wide, shown next to the name. */ width: number; choice: DeviceChoice }

/** Mobile/Laptop are plain sizes; Tablet and Desktop reuse the presets (they bring their own user agent and touch). */
export const QUICK_SIZES: readonly QuickSize[] = [
  { id: 'mobile', label: 'Mobile', width: 390, choice: { id: 'custom', w: 390, h: 844, dpr: 2 } },
  { id: 'tablet', label: 'Tablet', width: 768, choice: { id: 'ipad-mini' } },
  { id: 'laptop', label: 'Laptop', width: 1280, choice: { id: 'custom', w: 1280, h: 800, dpr: 1 } },
  { id: 'desktop', label: 'Desktop', width: 1920, choice: { id: 'desktop-1920' } },
]

export const RESPONSIVE_LABEL = 'Responsive'
/** The three sizes of "Open this page in 3 sizes". */
export const THREE_SIZES: readonly QuickSize[] = [QUICK_SIZES[0], QUICK_SIZES[1], QUICK_SIZES[3]]

const same = (a: DeviceChoice | null | undefined, b: DeviceChoice): boolean =>
  !!a && a.id === b.id && (a.w ?? 0) === (b.w ?? 0) && (a.h ?? 0) === (b.h ?? 0) && !a.landscape

/** The quick size a choice equals, if any (drives the menu's check mark). */
export const quickSizeOf = (c: DeviceChoice | null | undefined): QuickSize | undefined => QUICK_SIZES.find((q) => same(c, q.choice))

/** Corner indicator: the emulated device size, else the pane's own measured size; '' while unmeasured. */
export function sizeIndicator(device: DeviceChoice | null | undefined, measured: { w: number; h: number } | null): string {
  const d = resolveDevice(device)
  if (d) return `${d.w} × ${d.h}`
  return measured && measured.w > 0 ? `${Math.round(measured.w)} × ${Math.round(measured.h)}` : ''
}

/** Tooltip/aria text of the device button: what the pane is emulating. */
export function deviceButtonLabel(device: DeviceChoice | null | undefined): string {
  const d = resolveDevice(device)
  return d ? `Device: ${deviceLabel(d)}` : 'Device: Responsive (follows the pane size)'
}
