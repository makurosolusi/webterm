// Rute tab node browser: `/api/browser/:nodeId/tabs[/...]`. Auth sama dengan rute browser lain (gerbang `/api/*` di index.ts:
// Origin + token root; node-token tidak punya jalur ke prefix ini). Id divalidasi di sini; URL baru melewati penjaga
// navigasi/SSRF di host (tab di node berprofil X memakai profil X karena satu node = satu profil).
import { BlockedError } from '../shared/browser.contract'
import { MAX_TAB_URL_LENGTH, TAB_LIMIT_REASON, validateTabUrl } from '../shared/browser.tabs'
import type { BrowserTab, BrowserTabsState } from '../shared/browser.tabs'
import { isSafeNodeId } from '../shared/workspace'
import type { Pane } from '../shared/workspace.shape'
import { validLayout } from '../shared/browser.layout'
import { parseDeviceChoice } from '../shared/browser.devices'
import type { DeviceChoice } from '../shared/browser.devices'
import { createLogger } from './logs'
import { CdpCommandError } from './browser/cdp.client'
import { BrowserError } from './browser/browserHost.targets'
import { TabLimitError } from './browser/browserHost.tabs'
import { fail, readObject } from './browserApi.cookies'
import type { BrowserApiResult } from './browserApi.cookies'

/** What every tab endpoint answers with: the node's whole tab list plus the tab (or node) the action made. */
export interface TabsView { state: BrowserTabsState; tab?: BrowserTab; newNodeId?: string }

export interface TabsApiDeps {
  /** Tab list of a node (live, or the board's saved one); null = not a browser node. */
  get(nodeId: string): TabsView | null
  newTab(nodeId: string, o: { url?: string; afterTabId?: string }): Promise<TabsView>
  activate(nodeId: string, tabId: string): Promise<TabsView>
  close(nodeId: string, tabId: string): Promise<TabsView>
  move(nodeId: string, tabId: string, toIndex: number): Promise<TabsView>
  duplicate(nodeId: string, tabId: string): Promise<TabsView>
  popOut(nodeId: string, tabId: string): Promise<TabsView>
  reopen(nodeId: string): Promise<TabsView>
  /** Split layout (null = one pane); `focus` also moves the human's view to that tab. */
  setLayout(nodeId: string, layout: Pane | null, focus?: string): Promise<TabsView>
  /** One tab's own device (null = follow the pane/node size). */
  setDevice(nodeId: string, tabId: string, device: DeviceChoice | null): Promise<TabsView>
}

/** `{preset, landscape?}` | `{w, h, dpr?}` | `{preset: null}` -> the choice to store; undefined = invalid. */
function deviceFromBody(o: Record<string, unknown>): DeviceChoice | null | undefined {
  if ('preset' in o) return o.preset === null ? null : parseDeviceChoice({ id: o.preset, ...(o.landscape === undefined ? {} : { landscape: o.landscape }) })
  if (o.w !== undefined || o.h !== undefined) return parseDeviceChoice({ id: 'custom', w: o.w, h: o.h, dpr: o.dpr ?? 1, ...(o.landscape === undefined ? {} : { landscape: o.landscape }) })
  return undefined
}

const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/
const STATUS_BY_CODE: Record<string, number> = { not_found: 404, bad_request: 400, crashed: 502, launch_failed: 503, no_binary: 503, disabled: 403, blocked: 403 }

const log = createLogger('browser.api')

/** Galat aksi tab -> respons; galat tak dikenal dilempar ulang (500 oleh rute induk). */
function mapError(err: unknown): BrowserApiResult {
  if (err instanceof TabLimitError) return fail(409, 'tab_limit', { message: TAB_LIMIT_REASON })
  if (err instanceof BlockedError) {
    return err.reason === 'max_live' ? fail(409, 'max_live') : fail(403, 'blocked', { reason: err.reason, ...(err.hostname ? { hostname: err.hostname } : {}) })
  }
  if (err instanceof BrowserError) return fail(STATUS_BY_CODE[err.code] ?? 500, err.code, err.code === 'bad_request' ? { message: err.message } : {})
  if (err instanceof CdpCommandError) {
    log.error('browser.api', 'tab action failed in the browser', { error: err.message })
    return fail(502, 'crashed') // Chromium refused the command: a bad gateway, not a server bug
  }
  throw err
}

async function run(fn: () => Promise<TabsView>): Promise<BrowserApiResult> {
  try {
    return { status: 200, body: await fn() }
  } catch (err) {
    return mapError(err)
  }
}

/** Satu request tab; `rest` = segmen setelah `tabs`. null = bukan rute tab. */
export async function tabsRoute(method: string, nodeId: string, rest: string[], body: () => Promise<string>, d: TabsApiDeps): Promise<BrowserApiResult | null> {
  if (!isSafeNodeId(nodeId)) return fail(400, 'bad_request')
  const [a, b, ...more] = rest
  if (more.length) return null
  if (a === undefined) {
    if (method === 'GET') { const v = d.get(nodeId); return v ? { status: 200, body: v } : fail(404, 'not_found') }
    if (method !== 'POST') return fail(405, 'method_not_allowed')
    const read = await readObject(body)
    if (!read.ok) return read.result
    const { url, afterTabId } = read.value
    if (url !== undefined && (typeof url !== 'string' || url.length > MAX_TAB_URL_LENGTH || !validateTabUrl(url).ok)) return fail(400, 'bad_request', { message: 'url must be an http(s) URL or empty' })
    if (afterTabId !== undefined && (typeof afterTabId !== 'string' || !TAB_ID.test(afterTabId))) return fail(400, 'bad_request', { message: 'afterTabId is not a tab id' })
    return run(() => d.newTab(nodeId, { url: url as string | undefined, afterTabId: afterTabId as string | undefined }))
  }
  if (a === 'layout' && b === undefined) {
    if (method !== 'PUT' && method !== 'POST') return fail(405, 'method_not_allowed')
    const read = await readObject(body)
    if (!read.ok) return read.result
    const { layout, focus } = read.value
    if (layout !== null && validLayout(layout) === undefined) return fail(400, 'bad_request', { message: 'layout must be null or a pane tree of 2-4 distinct tabs' })
    if (focus !== undefined && (typeof focus !== 'string' || !TAB_ID.test(focus))) return fail(400, 'bad_request', { message: 'focus is not a tab id' })
    return run(() => d.setLayout(nodeId, layout as Pane | null, focus as string | undefined))
  }
  if (a === 'reopen' && b === undefined) return method === 'POST' ? run(() => d.reopen(nodeId)) : fail(405, 'method_not_allowed')
  if (!TAB_ID.test(a)) return fail(400, 'bad_request')
  if (b === undefined) return method === 'DELETE' ? run(() => d.close(nodeId, a)) : fail(405, 'method_not_allowed')
  if (method !== 'POST') return fail(405, 'method_not_allowed')
  switch (b) {
    case 'activate': return run(() => d.activate(nodeId, a))
    case 'duplicate': return run(() => d.duplicate(nodeId, a))
    case 'pop-out': return run(() => d.popOut(nodeId, a))
    case 'device': {
      const read = await readObject(body)
      if (!read.ok) return read.result
      const device = deviceFromBody(read.value)
      if (device === undefined) return fail(400, 'bad_request', { message: 'device must be {preset}, {preset: null} or {w, h, dpr?} within range' })
      return run(() => d.setDevice(nodeId, a, device))
    }
    case 'move': {
      const read = await readObject(body)
      if (!read.ok) return read.result
      const to = read.value.toIndex
      if (typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to > 64) return fail(400, 'bad_request', { message: 'toIndex must be a small non-negative integer' })
      return run(() => d.move(nodeId, a, to))
    }
    default: return fail(404, 'not_found')
  }
}
