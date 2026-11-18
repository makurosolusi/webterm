// Device-mode user agent that agrees with itself and with the engine. A preset's UA names Chrome/<major> and its Client
// Hints must name the same major; both come from the REAL engine (`Browser.getVersion`), never a number frozen in the
// preset table. Measured on Chrome 157: a "Pixel 8" sent `Chrome/150` in User-Agent but `"Google Chrome";v="157"` in
// sec-ch-ua, and `navigator.platform` stayed `MacIntel` (docs/decisions/browser-fingerprint.md, rows D1-D2).
import type { DeviceSpec, UaMetadata } from '../../shared/browser.devices'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'

const log = createLogger('browser.device')
const PRODUCT = /^([A-Za-z]+)\/((\d+)(?:\.[\d.]+)?)/
const GREASE = { brand: 'Not-A.Brand', version: '99' }
const BRAND_OF: Record<string, string | undefined> = { Chrome: 'Google Chrome', Edg: 'Microsoft Edge' }

export interface EngineIdentity { major: string; full: string; brand?: string }
let engine: EngineIdentity | undefined

/** `Chrome/157.0.8103.79` -> identity; null for a product string that is not Chromium-shaped. */
export function parseProduct(product: string): EngineIdentity | null {
  const m = PRODUCT.exec(product)
  return m ? { major: m[3], full: m[2], ...(BRAND_OF[m[1]] ? { brand: BRAND_OF[m[1]] } : {}) } : null
}

/** Remember the real engine once (a page session answers `Browser.getVersion`); a failure leaves the preset's own numbers. */
export async function learnEngine(send: (method: string, params?: object) => Promise<unknown>): Promise<void> {
  if (engine) return
  try {
    const r = (await send(CDP.getVersion)) as { product?: unknown }
    const parsed = typeof r.product === 'string' ? parseProduct(r.product) : null
    if (parsed) engine = parsed
  } catch (err) {
    log.warn('browser.device.engine', 'engine version unavailable; device presets keep their own version numbers', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Test seam: forget (or set) the learned engine. */
export function setEngineForTest(e: EngineIdentity | undefined): void { engine = e }

const swapMajor = (ua: string): string => (engine ? ua.replace(/Chrome\/\d+/, `Chrome/${engine.major}`) : ua)

/** Client Hints of a Chromium-based preset: the real engine's brands and versions plus the preset's platform fields. */
function metadataOf(meta: UaMetadata): object {
  if (!engine) return meta
  const named = (v: string) => [GREASE, ...(engine!.brand ? [{ brand: engine!.brand, version: v }] : []), { brand: 'Chromium', version: v }]
  return {
    ...meta,
    brands: named(engine.major),
    fullVersionList: named(engine.full).map((b) => (b.brand === GREASE.brand ? { brand: b.brand, version: '99.0.0.0' } : b)),
    fullVersion: engine.full,
  }
}

/** `Emulation.setUserAgentOverride` params of a device; empty UA = clear the override (desktop presets keep Chromium's own). */
export function userAgentParams(d: DeviceSpec): object {
  if (!d.ua) return { userAgent: '' }
  return { userAgent: d.uaMeta ? swapMajor(d.ua) : d.ua, ...(d.navPlatform ? { platform: d.navPlatform } : {}), ...(d.uaMeta ? { userAgentMetadata: metadataOf(d.uaMeta) } : {}) }
}
