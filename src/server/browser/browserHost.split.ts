// Split view of a browser node: several tabs on screen at once. The view (human's active tab = the focused pane) streams
// through `rec.cast` as before; every other on-screen tab gets its own screencast ("side"), at a low frame rate, tagged
// with its tab id. Also per-tab pane sizes and device emulation, and the layout itself (kept in step with tab closes).
// Everything off screen stops streaming. MAX_LIVE still counts nodes, not panes: a 4-pane node streams four pages.
import { DSF_MAX, TOUCH_POINTS_MAX } from '../../shared/browser.contract'
import type { BrowserInputEvent } from '../../shared/browser.contract'
import { resolveDevice } from '../../shared/browser.devices'
import type { DeviceChoice, DeviceSpec } from '../../shared/browser.devices'
import { MAX_PANES, assignTab, layoutTabIds, validLayout } from '../../shared/browser.layout'
import type { Pane } from '../../shared/workspace.shape'
import { createLogger } from '../logs'
import { CDP } from './cdp.client'
import { deviceCommands, responsiveCommands } from './browserHost.device'
import { screencastParams, toCdpCommands } from './browserHost.input'
import { BrowserError, pushSideFrame } from './browserHost.targets'
import type { NodeRec, SplitRt } from './browserHost.targets'
import type { TabKit } from './browserHost.tabs.kit'

const log = createLogger('browser.split')
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Chromium paints up to ~60 fps; every Nth frame of a pane that is not focused = ~5 fps. */
export const SIDE_EVERY_NTH = 12
/** Frame size factor of unfocused panes once more than two share the node (total pixels per second stay bounded). */
export const CROWDED_SCALE = 0.6

const identityOf = (d: DeviceSpec | null | undefined): string => `${d?.ua ?? ''}|${d?.mobile ?? false}|${d?.touch ?? false}`

export interface SplitDeps {
  liveSession(rec: NodeRec, tabId: string): Promise<string>
  /** Human focus moves to `tabId` (swaps the view page). */
  activate(rec: NodeRec, tabId: string): Promise<void>
}

export function createSplit(kit: TabKit, deps: SplitDeps) {
  const { tabsOf, find, must, emitTab, patchTab, setState, send, fire } = kit

  const rtOf = (rec: NodeRec): SplitRt => {
    const t = tabsOf(rec)
    return (t.split ??= { visible: [], side: new Map(), vp: new Map(), applied: new Map(), castKey: new Map(), identity: new Map(), touch: new Set(), tail: Promise.resolve() })
  }

  /** Device a tab is emulated as: its own choice, else the node's legacy device mode. */
  const deviceOf = (rec: NodeRec, tabId: string): DeviceSpec | null => {
    const own = find(tabsOf(rec), tabId)?.device
    return own ? resolveDevice(own) : rec.device ?? null
  }
  const sizeOf = (rec: NodeRec, tabId: string): { w: number; h: number; dpr: number } => {
    const d = deviceOf(rec, tabId)
    return d ? { w: d.w, h: d.h, dpr: d.dpr } : rtOf(rec).vp.get(tabId) ?? rec.viewport
  }
  /** Part of the emulation that is specific to this tab (own device or own pane size); '' = follows the node. */
  const overrideKey = (rec: NodeRec, tabId: string): string => {
    const own = find(tabsOf(rec), tabId)?.device
    const vp = rtOf(rec).vp.get(tabId)
    return own || vp ? JSON.stringify({ own: own ?? null, vp: vp ?? null }) : ''
  }
  const sessionOf = (rec: NodeRec, tabId: string): string | undefined => {
    const t = tabsOf(rec)
    return t.state.activeTabId === tabId ? rec.sessionId : t.rt.get(tabId)?.sessionId
  }

  /** Put the tab's page into its emulation (device or pane size); a changed identity (UA/mobile/touch) reloads like the node's device mode does. */
  async function applyEmulation(rec: NodeRec, tabId: string, sid: string): Promise<void> {
    const s = rtOf(rec)
    const dev = deviceOf(rec, tabId)
    const cmds = dev ? deviceCommands(dev) : responsiveCommands(sizeOf(rec, tabId))
    for (const c of cmds) await send(rec, sid, c.method, c.params)
    s.applied.set(tabId, overrideKey(rec, tabId))
    const was = s.identity.get(tabId) ?? identityOf(rec.device)
    s.identity.set(tabId, identityOf(dev))
    const url = find(tabsOf(rec), tabId)?.url
    if (was !== identityOf(dev) && url && url !== 'about:blank') await send(rec, sid, CDP.reload)
  }

  function castParams(rec: NodeRec, tabId: string, focus: boolean, crowded: boolean): Record<string, unknown> {
    const p = screencastParams(sizeOf(rec, tabId))
    if (focus) return p
    const k = crowded ? CROWDED_SCALE : 1
    return { ...p, maxWidth: Math.round((p.maxWidth as number) * k), maxHeight: Math.round((p.maxHeight as number) * k), everyNthFrame: SIDE_EVERY_NTH }
  }

  async function stopSide(rec: NodeRec, tabId: string): Promise<void> {
    const s = rtOf(rec)
    const c = s.side.get(tabId)
    s.side.delete(tabId)
    s.castKey.delete(tabId)
    if (c) fire(rec, c.sessionId, CDP.stopScreencast)
  }

  async function run(rec: NodeRec, extra: string[]): Promise<void> {
    const t = rec.tabs
    if (!t || !rec.sessionId) return
    const s = rtOf(rec)
    const active = t.state.activeTabId
    const shown = s.visible.filter((id) => find(t, id))
    const crowded = shown.length > 2
    const inSplit = shown.length > 1
    for (const id of [...s.side.keys()]) {
      const gone = !find(t, id) || find(t, id)?.crashed || !t.rt.get(id)?.sessionId // its page is gone: nothing to stop
      if (gone) { s.side.delete(id); s.castKey.delete(id) } else if (!rec.cast || !shown.includes(id) || id === active) await stopSide(rec, id)
    }
    const targets = new Set([...shown, ...extra, ...s.applied.keys()])
    for (const id of targets) {
      const tab = find(t, id)
      if (!tab) { s.applied.delete(id); continue }
      if (tab.crashed && id !== active) continue // a crashed pane waits for its Reload; it is not rebuilt behind the user's back
      const live = id === active || t.rt.get(id)?.sessionId
      if (!live && !shown.includes(id)) continue // off screen and no page: it takes its emulation when it wakes (the node's `emulate` plus this on show)
      const sid = id === active ? rec.sessionId : await deps.liveSession(rec, id)
      if (overrideKey(rec, id) !== (s.applied.get(id) ?? '')) await applyEmulation(rec, id, sid)
      if (!rec.cast || !shown.includes(id)) continue
      const focus = id === active
      if (focus && !inSplit && overrideKey(rec, id) === '') {
        if (s.castKey.delete(id)) await send(rec, sid, CDP.stopScreencast).then(() => send(rec, sid, CDP.startScreencast, screencastParams(rec.device ? { w: rec.device.w, h: rec.device.h, dpr: rec.device.dpr } : rec.viewport)))
        continue
      }
      const params = castParams(rec, id, focus, crowded)
      const key = JSON.stringify(params)
      if (s.castKey.get(id) === key && (focus || s.side.has(id))) continue
      s.castKey.set(id, key)
      if (!focus) s.side.set(id, { sessionId: sid })
      await send(rec, sid, CDP.stopScreencast) // restart with the new size/rate (a first start finds nothing to stop)
      await send(rec, sid, CDP.startScreencast, params)
    }
  }

  /** Bring streams and emulation in line with the tabs on screen; serialized per node. `extra` = tabs whose emulation to refresh without streaming. */
  function reconcile(rec: NodeRec, extra: string[] = []): Promise<void> {
    const s = rtOf(rec)
    const next = s.tail.then(() => run(rec, extra)).catch((err) => { log.warn('browser.split', 'reconciling the split view failed', { ids: { nodeId: rec.nodeId }, error: errMsg(err) }) })
    s.tail = next
    return next
  }

  /** The viewer's tabs on screen (one per pane) and the focused one. */
  async function setVisible(rec: NodeRec | undefined, visible: string[], focus?: string): Promise<void> {
    if (!rec?.sessionId || !rec.tabs) return // a node without a page (crashed, discarded) has nothing on screen to stream
    const t = tabsOf(rec)
    const shown = [...new Set(visible)].filter((id) => find(t, id)).slice(0, MAX_PANES)
    rtOf(rec).visible = shown
    if (focus && focus !== t.state.activeTabId && find(t, focus)) await deps.activate(rec, focus)
    await reconcile(rec)
  }

  function sidePush(rec: NodeRec, tabId: string, sessionId: string, p: Record<string, unknown>): void {
    if (rec.tabs?.split?.side.get(tabId)?.sessionId === sessionId) pushSideFrame(rec, tabId, sessionId, p)
  }

  /** `ackFrame` for a frame of an on-screen side tab: the ack goes to that tab's session. */
  function ackSide(rec: NodeRec, seq: number): void {
    const sid = rec.cast?.sides?.get(seq)
    if (!sid || !rec.cast) return
    rec.cast.sides?.delete(seq)
    const ackId = rec.cast.acks.get(seq)
    rec.cast.acks.delete(seq)
    if (ackId !== undefined) fire(rec, sid, CDP.screencastFrameAck, { sessionId: ackId })
  }

  /** The view moved from `from` to `to`: `to` was a side tab and is now the view's session, `from` becomes one of the others. */
  function swapped(rec: NodeRec, to: string, from: string | null): void {
    const s = rec.tabs?.split
    if (!s) return
    s.side.delete(to)
    s.castKey.delete(to)
    s.applied.delete(to) // the swap re-applied the node's emulation to it
    if (from) { s.castKey.delete(from); s.applied.delete(from) }
  }

  /** A tab's page size in its pane (CSS px); only meaningful in a split. */
  async function resizeTab(rec: NodeRec | undefined, tabId: string, vp: { w: number; h: number; dpr: number }): Promise<void> {
    if (!rec?.sessionId || !rec.tabs) return
    must(rec, tabId)
    const s = rtOf(rec)
    const cur = s.vp.get(tabId)
    const next = { w: Math.round(vp.w), h: Math.round(vp.h), dpr: Math.min(vp.dpr, DSF_MAX) }
    if (cur && cur.w === next.w && cur.h === next.h && cur.dpr === next.dpr) return
    s.vp.set(tabId, next)
    await reconcile(rec, [tabId])
  }

  /** This tab's own device (null = follow the pane/node size again). */
  async function setTabDevice(rec: NodeRec, tabId: string, choice: DeviceChoice | null): Promise<void> {
    must(rec, tabId)
    patchTab(rec, tabId, { device: choice })
    await reconcile(rec, [tabId])
  }

  /** Store a new layout (null = one pane), tell viewers, persist; focus moves when asked. Leaves must be tabs of the node. */
  async function setLayout(rec: NodeRec, layout: Pane | null, focus?: string): Promise<void> {
    const t = tabsOf(rec)
    const ids = t.state.tabs.map((x) => x.tabId)
    const clean = layout === null ? undefined : validLayout(layout, ids)
    if (layout !== null && !clean) throw new BrowserError('bad_request', `node ${rec.nodeId}: layout needs 2-${MAX_PANES} distinct tabs of this node`)
    if (focus !== undefined) must(rec, focus)
    applyLayout(rec, clean)
    if (focus && focus !== t.state.activeTabId) await deps.activate(rec, focus)
    else await reconcile(rec)
  }

  /** Layout changed (by a request, a tab close or a focus change): state, event, save, and the streams. */
  function applyLayout(rec: NodeRec, layout: Pane | undefined): void {
    const t = tabsOf(rec)
    if (t.state.layout === layout) return
    const next = { ...t.state }
    delete next.layout
    setState(rec, layout ? { ...next, layout } : next)
    noteLayout(rec, layout)
  }

  /** The state already holds `layout` (a tab close rewrote it): tell viewers and follow with the on-screen set. */
  function noteLayout(rec: NodeRec, layout: Pane | undefined): void {
    const s = rtOf(rec)
    emitTab(rec, { type: 'layoutChanged', nodeId: rec.nodeId, layout: layout ?? null })
    s.visible = layout ? layoutTabIds(layout) : []
    if (!layout) s.vp.clear() // back to one pane: the page follows the node size again
  }

  /** The human's focus landed on a tab that is not in the split: it takes over the pane the previous focus held. */
  function followFocus(rec: NodeRec, to: string, from: string | null): void {
    const l = tabsOf(rec).state.layout
    if (!l || !from || layoutTabIds(l).includes(to)) return
    applyLayout(rec, assignTab(l, from, to))
  }

  /** Everything off: viewers are gone (or the page is). */
  async function stopAll(rec: NodeRec): Promise<void> {
    const s = rec.tabs?.split
    if (!s) return
    for (const id of [...s.side.keys()]) await stopSide(rec, id)
    s.castKey.clear()
  }

  function clear(rec: NodeRec): void {
    const s = rec.tabs?.split
    if (!s) return
    s.side.clear(); s.castKey.clear(); s.applied.clear(); s.identity.clear(); s.touch.clear()
  }

  /** Input for the pane of a tab that is not the focused one: straight to its page (never woken for a stray input). */
  function input(rec: NodeRec, tabId: string, ev: BrowserInputEvent): void {
    const sid = sessionOf(rec, tabId)
    if (!sid) return
    const s = rtOf(rec)
    if (ev.t === 'touch' && !s.touch.has(tabId)) { s.touch.add(tabId); fire(rec, sid, CDP.setTouchEmulation, { enabled: true, maxTouchPoints: TOUCH_POINTS_MAX }) }
    for (const c of toCdpCommands(ev)) fire(rec, sid, c.method, c.params)
  }
  const isShown = (rec: NodeRec, tabId: string): boolean => !!rec.tabs?.split?.visible.includes(tabId)

  return { reconcile, setVisible, resizeTab, setTabDevice, setLayout, applyLayout, noteLayout, followFocus, sidePush, ackSide, swapped, stopAll, clear, input, isShown, rtOf }
}

export type SplitSide = ReturnType<typeof createSplit>
