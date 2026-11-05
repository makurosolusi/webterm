// Device mode for browser nodes (Chrome DevTools Device Toolbar): preset table + validation of a node's choice.
// Pure, shared by client (picker/header) and server (CDP emulation). The server resolves presets itself, so a
// client never supplies a user agent string.

/** Bounds for a Custom device (CSS px / device pixel ratio); DevTools accepts similar ranges. */
export const DEVICE_DIM_MIN = 50
export const DEVICE_DIM_MAX = 4096
export const DEVICE_DPR_MIN = 0.5
export const DEVICE_DPR_MAX = 4
export const DEVICE_CUSTOM = 'custom'

/** Client hints sent with a user agent override (`Emulation.UserAgentMetadata` required fields). */
export interface UaMetadata { platform: string; platformVersion: string; architecture: string; model: string; mobile: boolean }

export interface DevicePreset {
  id: string; name: string; w: number; h: number; dpr: number; mobile: boolean; touch: boolean
  /** Absent = keep Chromium's own user agent (desktop presets). */
  ua?: string; uaMeta?: UaMetadata
}

// Frozen OS tokens, as the real browsers send them (Safari 26 pins iOS 18_7; Chrome's reduced UA pins Android 10; K).
const CHROME = '150.0.0.0'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const ANDROID_UA = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Mobile Safari/537.36`
const WINDOWS_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME} Safari/537.36`
const android = (model: string): UaMetadata => ({ platform: 'Android', platformVersion: '16.0.0', architecture: '', model, mobile: true })
const iphone = (id: string, name: string, w: number, h: number, dpr: number): DevicePreset => ({ id, name, w, h, dpr, mobile: true, touch: true, ua: IPHONE_UA })
const ipad = (id: string, name: string, w: number, h: number): DevicePreset => ({ id, name, w, h, dpr: 2, mobile: true, touch: true, ua: IPAD_UA })

/** Presets in picker order; sizes are CSS px in portrait (Chrome DevTools values). Responsive is `null`, not a preset. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  iphone('iphone-se', 'iPhone SE', 375, 667, 2),
  iphone('iphone-15-pro', 'iPhone 15 Pro', 393, 852, 3),
  iphone('iphone-15-pro-max', 'iPhone 15 Pro Max', 430, 932, 3),
  { id: 'pixel-8', name: 'Pixel 8', w: 412, h: 915, dpr: 2.625, mobile: true, touch: true, ua: ANDROID_UA, uaMeta: android('Pixel 8') },
  { id: 'galaxy-s23', name: 'Samsung Galaxy S23', w: 360, h: 780, dpr: 3, mobile: true, touch: true, ua: ANDROID_UA, uaMeta: android('SM-S911B') },
  ipad('ipad-mini', 'iPad Mini', 768, 1024),
  ipad('ipad-air', 'iPad Air', 820, 1180),
  ipad('ipad-pro-12', 'iPad Pro 12.9"', 1024, 1366),
  { id: 'surface-pro', name: 'Surface Pro', w: 912, h: 1368, dpr: 2, mobile: false, touch: true, ua: WINDOWS_UA, uaMeta: { platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false } },
  { id: 'desktop-1440', name: 'Desktop 1440', w: 1440, h: 900, dpr: 1, mobile: false, touch: false },
  { id: 'desktop-1920', name: 'Desktop 1920', w: 1920, h: 1080, dpr: 1, mobile: false, touch: false },
]

/** What a node stores (`WsNode.device`) and the client sends: a preset id, or `custom` with its size. */
export interface DeviceChoice { id: string; landscape?: boolean; w?: number; h?: number; dpr?: number }

/** A resolved device: what the server emulates and the header shows (`w`/`h` already rotated). */
export interface DeviceSpec extends DevicePreset { landscape: boolean }

const dimOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= DEVICE_DIM_MIN && v <= DEVICE_DIM_MAX
const dprOk = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= DEVICE_DPR_MIN && v <= DEVICE_DPR_MAX

/** Validate an untrusted choice: `null` = Responsive, `undefined` = invalid (reject). Unknown keys are dropped. */
export function parseDeviceChoice(v: unknown): DeviceChoice | null | undefined {
  if (v === null) return null
  if (typeof v !== 'object' || Array.isArray(v) || v === undefined) return undefined
  const o = v as Record<string, unknown>
  if (o.landscape !== undefined && typeof o.landscape !== 'boolean') return undefined
  const landscape = o.landscape === true ? { landscape: true } : {}
  if (o.id === DEVICE_CUSTOM) return dimOk(o.w) && dimOk(o.h) && dprOk(o.dpr) ? { id: DEVICE_CUSTOM, w: o.w, h: o.h, dpr: o.dpr, ...landscape } : undefined
  return DEVICE_PRESETS.some((p) => p.id === o.id) ? { id: o.id as string, ...landscape } : undefined
}

/** Choice -> spec (rotation applied); null for Responsive or anything invalid. */
export function resolveDevice(choice: unknown): DeviceSpec | null {
  const c = parseDeviceChoice(choice)
  if (!c) return null
  const base: DevicePreset = c.id === DEVICE_CUSTOM
    ? { id: DEVICE_CUSTOM, name: 'Custom', w: c.w as number, h: c.h as number, dpr: c.dpr as number, mobile: false, touch: false }
    : DEVICE_PRESETS.find((p) => p.id === c.id) as DevicePreset
  const landscape = c.landscape === true
  return { ...base, landscape, w: landscape ? base.h : base.w, h: landscape ? base.w : base.h }
}

/** Header text, e.g. "iPhone 15 Pro · 393×852 · 3x". */
export function deviceLabel(d: DeviceSpec): string {
  return `${d.name} · ${d.w}×${d.h} · ${d.dpr}x`
}
