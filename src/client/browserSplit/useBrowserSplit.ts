// Split view controller of one browser node: turns "split / close pane / drop a tab / resize ..." into layout changes
// (the pure reducers of shared/browser.layout.ts), keeps the tab list in step (hidden tab or a new one for a new pane) and
// tells the server which tabs are on screen. The server owns the layout; this hook edits it optimistically and saves.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { MAX_TABS_PER_NODE, TAB_LIMIT_REASON } from '../../shared/browser.tabs'
import type { BrowserTabsState } from '../../shared/browser.tabs'
import {
  MIN_PANE_PX, assignTab, canSplit, closePane, focusPane, layoutTabIds, movePane, normalizeLayout, resizePane, splitPane, swapPanes,
} from '../../shared/browser.layout'
import type { Direction, DropEdge } from '../../shared/browser.layout'
import type { DeviceChoice } from '../../shared/browser.devices'
import type { Pane } from '../../shared/workspace.shape'
import { paneLayout } from '../paneTree'
import type { BrowserSession } from '../browser.useSession'
import type { BrowserTabsControl } from '../browserTabs/useBrowserTabs'
import { isBlankTab } from '../browserTabs/browserTabs.labels'
import { THREE_SIZES } from './browserSplit.devices'
import type { DropZone } from './browserSplit.drop'

export const FIT_REASON = 'Enlarge the node to split'
export type Preset = 'columns' | 'rows' | 'grid'
const SEPARATOR_PX = 6

interface Stage { w: number; h: number }

export interface SplitControls {
  layout: Pane | null
  /** Tabs on screen, one per pane (the active tab alone when there is no split). */
  shown: string[]
  focusId: string | null
  stage: Stage
  /** Whether the pane of `tabId` can take another split on `edge`: the pane limit, then the room left. */
  canSplitAt(tabId: string, edge: DropEdge): { ok: true } | { ok: false; reason: string }
  split(edge: DropEdge, targetTabId?: string): Promise<void>
  preset(kind: Preset): Promise<void>
  openInSizes(): Promise<void>
  dropTab(tabId: string, target: string, zone: DropZone): Promise<void>
  focus(tabId: string): void
  reload(tabId: string): void
  moveFocus(dir: Direction): void
  closePane(tabId: string): Promise<void>
  unsplit(): Promise<void>
  assign(paneTabId: string, tabId: string): Promise<void>
  swap(a: string, b: string): Promise<void>
  /** Drag-and-drop landing: `center` swaps, an edge moves the pane beside `target`. */
  movePane(tabId: string, target: string, zone: DropZone): Promise<void>
  /** Whether dropping `tabId` on `zone` of `target` is possible (room left for an edge move). */
  canMovePane(tabId: string, target: string, zone: DropZone): boolean
  /** Keyboard move: swap with the neighbouring pane in `dir` (Alt+Shift+Arrow, context menu). Returns whether a pane moved. */
  moveDir(tabId: string, dir: Direction): Promise<boolean>
  /** Neighbouring pane (tab id) of `tabId` in `dir`, null at the edge of the layout. */
  neighbour(tabId: string, dir: Direction): string | null
  /** Last move, worded for the aria-live region. */
  announcement: string
  resize(path: string, ratio: number): void
  commitResize(): Promise<void>
  resetRatio(path: string): Promise<void>
  setDevice(tabId: string, d: DeviceChoice | null): Promise<void>
  navigateIn(tabId: string, url: string): Promise<void>
}

/** 1-based reading-order number of the pane showing `tabId` (what the aria-live line calls it). */
const paneNo = (l: Pane, tabId: string): number => layoutTabIds(l).indexOf(tabId) + 1

/** Pixel size of the pane showing `tabId` inside a stage of `stage`. */
function paneSize(layout: Pane | null, tabId: string, stage: Stage): Stage {
  const box = layout ? paneLayout(layout).panes.find((p) => p.id === tabId) : undefined
  return box ? { w: (stage.w * box.width) / 100, h: (stage.h * box.height) / 100 } : stage
}

/** Nearest tab not on screen: right of the focused one in strip order, then left. */
function hiddenTab(state: BrowserTabsState, shown: string[], from: string | null): string | undefined {
  const order = state.tabs.map((t) => t.tabId)
  const i = Math.max(0, order.indexOf(from ?? ''))
  return [...order.slice(i + 1), ...order.slice(0, i).reverse()].find((id) => !shown.includes(id))
}

export function useBrowserSplit(tabs: BrowserTabsControl, session: BrowserSession, send: (m: { t: 'nav'; action: 'go'; url: string }) => void, hostRef: RefObject<HTMLElement | null>): SplitControls {
  const { view } = tabs
  const layout = view.layout ?? null
  const focusId = view.activeTabId
  const shown = useMemo(() => (layout ? layoutTabIds(layout) : focusId ? [focusId] : []), [layout, focusId])
  const [stage, setStage] = useState<Stage>({ w: 0, h: 0 })
  const [announcement, setAnnouncement] = useState('')
  const latest = useRef({ tabs, layout, focusId, shown, stage, view, session })
  latest.current = { tabs, layout, focusId, shown, stage, view, session }

  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [hostRef])

  // Tell the server which tabs are on screen and which one has the focus; it streams exactly those. Again after every attach.
  const key = `${shown.join(',')}|${focusId ?? ''}|${tabs.epoch}`
  useEffect(() => {
    const { shown: sh, focusId: f, session: s, tabs: tc } = latest.current
    if (tc.standIn) return
    s.send({ t: 'view', visible: sh, ...(f ? { focus: f } : {}) })
  }, [key])

  const canSplitAt = useCallback((tabId: string, edge: DropEdge) => {
    const { layout: l, stage: s } = latest.current
    const lim = canSplit(l)
    if (!lim.ok) return lim
    const size = paneSize(l, tabId, s)
    const need = 2 * MIN_PANE_PX + SEPARATOR_PX
    const room = edge === 'left' || edge === 'right' ? size.w : size.h
    return s.w > 0 && room < need ? { ok: false as const, reason: FIT_REASON } : { ok: true as const }
  }, [])

  const refuse = useCallback((reason: string) => { latest.current.tabs.notify(reason, 'warning') }, [])

  /** A tab for a new pane: a hidden one, else a fresh tab (optionally at `url`). */
  const tabForPane = useCallback(async (from: string | null, url?: string): Promise<string | null> => {
    const { view: v, shown: sh, tabs: tc } = latest.current
    const hidden = url === undefined ? hiddenTab(v, sh, from) : undefined
    if (hidden) return hidden
    const t = await tc.createTab(url, from ?? undefined)
    return t?.tabId ?? null
  }, [])

  const split = useCallback(async (edge: DropEdge, targetTabId?: string) => {
    const { layout: l, focusId: f, tabs: tc } = latest.current
    const target = targetTabId ?? f
    if (!target) return
    const ok = canSplitAt(target, edge)
    if (!ok.ok) { refuse(ok.reason); return }
    const id = await tabForPane(target)
    if (id) await tc.setLayout(splitPane(l, target, id, edge), { focus: id })
  }, [canSplitAt, refuse, tabForPane])

  /** Tabs for `n` panes: the ones on screen first, then hidden ones in strip order, then new ones. */
  const collect = useCallback(async (n: number, url?: string): Promise<string[] | null> => {
    const { view: v, shown: sh, tabs: tc } = latest.current
    const out = url === undefined ? [...sh, ...v.tabs.map((t) => t.tabId).filter((id) => !sh.includes(id))].slice(0, n) : sh.slice(0, 1)
    if (v.tabs.length + Math.max(0, n - out.length) > MAX_TABS_PER_NODE && out.length < n) { refuse(TAB_LIMIT_REASON); return null }
    while (out.length < n) {
      const t = await tc.createTab(url, out[out.length - 1])
      if (!t) return null
      out.push(t.tabId)
    }
    return out
  }, [refuse])

  const preset = useCallback(async (kind: Preset) => {
    const { stage: s, tabs: tc } = latest.current
    const n = kind === 'grid' ? 4 : 2
    if (s.w > 0 && (kind === 'rows' ? s.h : s.w) < 2 * MIN_PANE_PX + SEPARATOR_PX) { refuse(FIT_REASON); return }
    if (kind === 'grid' && s.w > 0 && (s.w < 2 * MIN_PANE_PX + SEPARATOR_PX || s.h < 2 * MIN_PANE_PX + SEPARATOR_PX)) { refuse(FIT_REASON); return }
    const ids = await collect(n)
    if (!ids) return
    const leaf = (id: string): Pane => ({ id })
    const next: Pane = kind === 'columns' ? { dir: 'h', ratio: 0.5, a: leaf(ids[0]), b: leaf(ids[1]) }
      : kind === 'rows' ? { dir: 'v', ratio: 0.5, a: leaf(ids[0]), b: leaf(ids[1]) }
        : { dir: 'v', ratio: 0.5, a: { dir: 'h', ratio: 0.5, a: leaf(ids[0]), b: leaf(ids[1]) }, b: { dir: 'h', ratio: 0.5, a: leaf(ids[2]), b: leaf(ids[3]) } }
    await tc.setLayout(next, { focus: ids[0] })
  }, [collect, refuse])

  const openInSizes = useCallback(async () => {
    const { view: v, focusId: f, tabs: tc, stage: s } = latest.current
    const active = v.tabs.find((t) => t.tabId === f)
    if (!active || isBlankTab(active)) { refuse('Open a page first, then open it in 3 sizes'); return }
    if (s.w > 0 && s.w < 3 * MIN_PANE_PX + 2 * SEPARATOR_PX) { refuse(FIT_REASON); return }
    const ids = await collect(THREE_SIZES.length, active.url)
    if (!ids) return
    const next: Pane = { dir: 'h', ratio: 0.25, a: { id: ids[0] }, b: { dir: 'h', ratio: 0.4, a: { id: ids[1] }, b: { id: ids[2] } } }
    await tc.setLayout(next, { focus: ids[0] })
    await Promise.all(THREE_SIZES.map((q, i) => tc.setTabDevice(ids[i], q.choice)))
  }, [collect, refuse])

  const focus = useCallback((tabId: string) => {
    const { focusId: f, tabs: tc } = latest.current
    if (tabId !== f) tc.act({ type: 'activate', tabId })
  }, [])

  const save = useCallback((next: Pane | null, focusTab?: string) => latest.current.tabs.setLayout(normalizeLayout(next), { focus: focusTab }), [])

  const dropTab = useCallback(async (tabId: string, target: string, zone: DropZone) => {
    const { layout: l, tabs: tc } = latest.current
    if (zone === 'center') {
      if (l) await save(assignTab(l, target, tabId), tabId)
      else tc.act({ type: 'activate', tabId })
      return
    }
    if (tabId === target) return
    // A tab already on screen moves: its old pane closes first, so a move never counts against the limit.
    const base = l && layoutTabIds(l).includes(tabId) ? closePane(l, tabId) : l
    const ok = canSplitAt(target, zone)
    if (base === l && !ok.ok) { refuse(ok.reason); return }
    await save(splitPane(base, target, tabId, zone), tabId)
  }, [canSplitAt, refuse, save])

  const reload = useCallback((tabId: string) => latest.current.tabs.act({ type: 'reload', tabId }), [])

  const moveFocus = useCallback((dir: Direction) => {
    const { layout: l, focusId: f } = latest.current
    if (!l || !f) return
    const to = focusPane(l, f, dir)
    if (to !== f) focus(to)
  }, [focus])

  const closeOne = useCallback(async (tabId: string) => {
    const { layout: l, focusId: f } = latest.current
    if (!l) return
    const next = closePane(l, tabId)
    const keep = f && layoutTabIds(next).includes(f) ? f : layoutTabIds(next)[0]
    await save(next, keep === f ? undefined : keep)
  }, [save])

  const unsplit = useCallback(async () => { await latest.current.tabs.setLayout(null) }, [])
  const assign = useCallback(async (paneTabId: string, tabId: string) => {
    const { layout: l, focusId: f } = latest.current
    if (l) await save(assignTab(l, paneTabId, tabId), f === paneTabId ? tabId : undefined)
  }, [save])
  const swap = useCallback(async (a: string, b: string) => {
    const { layout: l } = latest.current
    if (l) await save(swapPanes(l, a, b))
  }, [save])

  const canMovePane = useCallback((tabId: string, target: string, zone: DropZone) => {
    const { layout: l, stage: s } = latest.current
    if (!l || tabId === target) return false
    if (zone === 'center') return true
    const size = paneSize(l, target, s)
    const room = zone === 'left' || zone === 'right' ? size.w : size.h
    return s.w <= 0 || room >= 2 * MIN_PANE_PX + SEPARATOR_PX
  }, [])
  const movePaneTo = useCallback(async (tabId: string, target: string, zone: DropZone) => {
    const { layout: l } = latest.current
    if (!l || !canMovePane(tabId, target, zone)) return
    const next = movePane(l, tabId, target, zone)
    if (next === l) return
    setAnnouncement(zone === 'center' ? `Pane ${paneNo(l, tabId)} swapped with pane ${paneNo(l, target)}` : `Pane ${paneNo(next, tabId)} moved to the ${zone} of pane ${paneNo(next, target)}`)
    await save(next)
  }, [canMovePane, save])
  const neighbour = useCallback((tabId: string, dir: Direction): string | null => {
    const l = latest.current.layout
    const to = l ? focusPane(l, tabId, dir) : tabId
    return to === tabId ? null : to
  }, [])
  const moveDir = useCallback(async (tabId: string, dir: Direction): Promise<boolean> => {
    const { layout: l } = latest.current
    const to = neighbour(tabId, dir)
    if (!l || !to) { setAnnouncement(`Pane cannot move ${dir === 'up' || dir === 'down' ? dir : `to the ${dir}`}`); return false }
    const next = swapPanes(l, tabId, to)
    setAnnouncement(`Pane ${paneNo(next, tabId)} moved ${dir === 'up' || dir === 'down' ? dir : `to the ${dir}`}`)
    await save(next)
    return true
  }, [neighbour, save])

  // The layout being dragged: React has not re-rendered between two pointer events, so the latest value lives here.
  const draft = useRef<Pane | null>(null)
  const resize = useCallback((path: string, ratio: number) => {
    const base = draft.current ?? latest.current.layout
    if (!base) return
    draft.current = resizePane(base, path, ratio)
    void latest.current.tabs.setLayout(draft.current, { save: false })
  }, [])
  const commitResize = useCallback(async () => {
    const l = draft.current
    draft.current = null
    if (l) await latest.current.tabs.setLayout(l)
  }, [])
  const resetRatio = useCallback(async (path: string) => {
    const { layout: l, tabs: tc } = latest.current
    if (l) await tc.setLayout(resizePane(l, path, 0.5))
  }, [])

  const setDevice = useCallback((tabId: string, d: DeviceChoice | null) => latest.current.tabs.setTabDevice(tabId, d), [])
  const navigateIn = useCallback(async (tabId: string, url: string) => {
    const { focusId: f, tabs: tc, layout: l } = latest.current
    if (tabId !== f) await tc.setLayout(l, { focus: tabId })
    send({ t: 'nav', action: 'go', url })
  }, [send])

  return { layout, shown, focusId, stage, canSplitAt, split, preset, openInSizes, dropTab, focus, reload, moveFocus, closePane: closeOne, unsplit, assign, swap, movePane: movePaneTo, canMovePane, moveDir, neighbour, announcement, resize, commitResize, resetRatio, setDevice, navigateIn }
}
