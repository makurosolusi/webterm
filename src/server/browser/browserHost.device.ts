// Viewport + device mode (Chrome DevTools Device Toolbar) for one node's page. Responsive: the page follows the node
// size (`resizeViewport`). Device: fixed CSS size, DPR, mobile flag, touch, user agent; node resizes are only
// remembered so Responsive can restore them. Split from browserHost.service.ts, which calls in with its CDP `io`.
import { TOUCH_POINTS_MAX } from '../../shared/browser.contract'
import { resolveDevice } from '../../shared/browser.devices'
import type { DeviceChoice, DeviceSpec } from '../../shared/browser.devices'
import { CDP } from './cdp.client'
import { restartStream } from './browserHost.cast'
import { metricsParams, screencastParams } from './browserHost.input'
import type { CdpCommand } from './browserHost.input'
import type { NodeRec } from './browserHost.targets'

export type { DeviceChoice }

/** The host's CDP send for one node: `send` awaits, `fire` logs failures instead of throwing. */
export interface DeviceIo {
  send(method: string, params?: object): Promise<unknown>
  fire(method: string, params?: object): void
}

/** Viewport the page renders at (screencast frame bounds): the device when one is active, else the node size. */
export function castViewport(rec: NodeRec): NodeRec['viewport'] {
  return rec.device ? { w: rec.device.w, h: rec.device.h, dpr: rec.device.dpr } : rec.viewport
}

/** Emulation calls that put the page into `d` (DevTools DeviceModeModel: metrics + touch + UA). */
export function deviceCommands(d: DeviceSpec): CdpCommand[] {
  const orientation = d.landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 }
  return [
    { method: CDP.setDeviceMetrics, params: { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: d.mobile, screenOrientation: orientation } },
    { method: CDP.setTouchEmulation, params: d.touch ? { enabled: true, maxTouchPoints: TOUCH_POINTS_MAX } : { enabled: false } },
    { method: CDP.setEmitTouch, params: d.touch ? { enabled: true, configuration: d.mobile ? 'mobile' : 'desktop' } : { enabled: false } },
    // Empty user agent = clear the override (desktop presets keep Chromium's own UA).
    { method: CDP.setUserAgent, params: d.ua ? { userAgent: d.ua, ...(d.uaMeta ? { userAgentMetadata: d.uaMeta } : {}) } : { userAgent: '' } },
  ]
}

/** Back to Responsive: the node size again, and touch/UA overrides cleared. */
export function responsiveCommands(vp: NodeRec['viewport']): CdpCommand[] {
  return [
    { method: CDP.setDeviceMetrics, params: metricsParams(vp.w, vp.h, vp.dpr) },
    { method: CDP.setTouchEmulation, params: { enabled: false } },
    { method: CDP.setEmitTouch, params: { enabled: false } },
    { method: CDP.setUserAgent, params: { userAgent: '' } },
  ]
}

const castKey = (rec: NodeRec) => JSON.stringify(screencastParams(castViewport(rec)))

/** Frame bounds follow the rendered size: restart a running screencast when they changed (DevTools ScreencastView: stop/start). */
async function restartCast(rec: NodeRec, io: DeviceIo, before: string): Promise<void> {
  if (!rec.cast || castKey(rec) === before) return
  await restartStream((m, p) => io.send(m, p), screencastParams(castViewport(rec)), `node ${rec.nodeId}`)
}

/** Node resized: remember the size; it reaches the page only in Responsive mode. */
export async function resizeViewport(rec: NodeRec, vp: NodeRec['viewport'], io: DeviceIo): Promise<void> {
  const before = castKey(rec)
  rec.viewport = vp
  if (rec.device || rec.tabs?.split?.vp.has(rec.tabs.state.activeTabId ?? '')) return // a device, or the view's own pane size, wins over the node's
  await io.send(CDP.setDeviceMetrics, metricsParams(vp.w, vp.h, vp.dpr))
  io.fire(CDP.setVisibleSize, { width: Math.round(vp.w), height: Math.round(vp.h) }) // Orca ...-device-metrics.ts:45-54
  await restartCast(rec, io, before)
}

/** Switch device (null = Responsive). Reloads when the UA/mobile/touch identity changed, so server-rendered pages see it. */
export async function setDevice(rec: NodeRec, choice: DeviceChoice | null, io: DeviceIo): Promise<void> {
  const next = resolveDevice(choice)
  const was = rec.device ?? null
  if (JSON.stringify(was) === JSON.stringify(next)) return
  const before = castKey(rec)
  rec.device = next
  for (const c of next ? deviceCommands(next) : responsiveCommands(rec.viewport)) await io.send(c.method, c.params)
  rec.touch = next?.touch ?? false
  await restartCast(rec, io, before)
  const identity = (d: DeviceSpec | null) => `${d?.ua ?? ''}|${d?.mobile ?? false}|${d?.touch ?? false}`
  if (identity(was) !== identity(next) && rec.state.url) await io.send(CDP.reload)
}

/**
 * Fresh target (open / reopen after crash or discard), before its first navigation: re-apply the node's device.
 * A node seen for the first time takes the device saved on the board (`seed`), so the choice survives a restart.
 */
export async function restoreDevice(rec: NodeRec, seed: () => unknown, io: DeviceIo): Promise<void> {
  if (rec.device === undefined) rec.device = resolveDevice(seed())
  if (!rec.device) return
  for (const c of deviceCommands(rec.device)) await io.send(c.method, c.params)
  rec.touch = rec.device.touch
}
