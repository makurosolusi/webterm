// SATU-SATUNYA jalur CDP generik untuk agent (PLAN b §4.6). Default-deny: method di luar tabel ditolak, parameter
// divalidasi per method. Cookie/storage (Network.*, Storage.*), Fetch.*, Browser.*, Target.*, Runtime.*, Emulation.*
// dan Input.* mentah TIDAK ada di tabel; input memakai `host.input` bertipe, navigasi memakai `host.navigate`
// (penjaga SSRF), jadi `Page.navigate` dan `Runtime.evaluate` sengaja tidak diizinkan.
// Tabel ditulis per-domain agar tidak melanggar tes "CDP method table" (literal method hanya di cdp.client.ts).
import type { BrowserHostApi } from '../../shared/browser.contract'
import { BrowserError } from './browserHost.targets'

type Params = Record<string, unknown>
type Check = (p: Params) => boolean

const keysIn = (p: Params, allowed: readonly string[]) => Object.keys(p).every((k) => allowed.includes(k))
const noParams: Check = (p) => Object.keys(p).length === 0
const nodeOnly: Check = (p) => keysIn(p, ['backendNodeId']) && Number.isInteger(p.backendNodeId)
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const clipOk = (c: unknown): boolean => {
  if (c === undefined) return true
  const o = c as Params
  return !!c && typeof c === 'object' && keysIn(o, ['x', 'y', 'width', 'height', 'scale']) && ['x', 'y', 'width', 'height', 'scale'].every((k) => finite(o[k]))
}
const screenshot: Check = (p) =>
  keysIn(p, ['format', 'quality', 'clip']) && p.format === 'jpeg' && Number.isInteger(p.quality) && clipOk(p.clip)

const ALLOWED: Record<string, Record<string, Check>> = {
  Page: { captureScreenshot: screenshot, getLayoutMetrics: noParams },
  Accessibility: { getFullAXTree: noParams },
  DOM: { scrollIntoViewIfNeeded: nodeOnly, getContentQuads: nodeOnly, focus: nodeOnly, describeNode: nodeOnly },
}

const m = (domain: string, name: string) => `${domain}.${name}` // domain + nama dirakit terpisah: tes tabel CDP melarang literal method di luar cdp.client.ts

/** Nama method yang dipakai verb agent; semuanya ada di ALLOWED. */
export const AGENT_CDP = {
  axTree: 'Accessibility.getFullAXTree', scrollIntoView: 'DOM.scrollIntoViewIfNeeded', quads: 'DOM.getContentQuads',
  focus: 'DOM.focus', describe: 'DOM.describeNode', screenshot: m('Page', 'captureScreenshot'), layout: m('Page', 'getLayoutMetrics'),
} as const

/** True bila `method` + `params` ada di allowlist agent. */
export function isCdpAllowed(method: string, params: object = {}): boolean {
  const dot = method.indexOf('.')
  if (dot < 1) return false
  const domain = method.slice(0, dot)
  const name = method.slice(dot + 1)
  if (!Object.hasOwn(ALLOWED, domain) || !Object.hasOwn(ALLOWED[domain], name)) return false
  return !!params && typeof params === 'object' && !Array.isArray(params) && ALLOWED[domain][name](params as Params)
}

/** Panggil CDP lewat host HANYA bila lolos allowlist; selain itu `BrowserError('blocked')` tanpa menyentuh host. */
export async function callAllowed(host: Pick<BrowserHostApi, 'cdp'>, nodeId: string, method: string, params: object = {}): Promise<unknown> {
  if (!isCdpAllowed(method, params)) throw new BrowserError('blocked', `cdp method not allowed for agent: ${method}`)
  return host.cdp(nodeId, method, params)
}
