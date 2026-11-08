// State of the secondary side bar (VS Code's auxiliary bar on the right): open/closed, the shown
// view (Central chat or the Central control panel), and its width. Open state and view persist
// under `webterm.secondarySideBar`; the width is a `panelSize` store like the bottom panel height.
import { useSyncExternalStore } from 'react'
import { createPanelSize } from './panelSize'

export type SideBarView = 'chat' | 'central'
export interface SideBarState {
  open: boolean
  view: SideBarView
}

export const SIDE_BAR_KEY = 'webterm.secondarySideBar'
export const SIDE_BAR_WIDTH_KEY = 'webterm.secondarySideBarWidth'
export const SIDE_BAR_MIN_WIDTH = 260
export const SIDE_BAR_DEFAULT_WIDTH = 380
/** Below this window width the side bar overlays the canvas from the right instead of squeezing it. */
export const SIDE_BAR_OVERLAY_BREAKPOINT = 900
/** Open-state keys of the old bottom-panel Chat and Central tabs, read once to migrate them. */
export const LEGACY_CHAT_OPEN_KEY = 'webterm.chatOpen'
export const LEGACY_CENTRAL_OPEN_KEY = 'webterm.centralControlOpen'

export const sideBarWidth = createPanelSize({
  key: SIDE_BAR_WIDTH_KEY,
  cssVar: '--secondary-side-bar-w',
  min: SIDE_BAR_MIN_WIDTH,
  maxRatio: 0.6,
  defaultSize: () => SIDE_BAR_DEFAULT_WIDTH,
  viewport: () => window.innerWidth,
  // The sash is on the left edge: dragging or stepping left widens the side bar.
  growKey: 'ArrowLeft',
  shrinkKey: 'ArrowRight',
})

const CLOSED: SideBarState = { open: false, view: 'chat' }

function readStored(): SideBarState {
  try {
    const raw = localStorage.getItem(SIDE_BAR_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SideBarState>
      return { open: parsed.open === true, view: parsed.view === 'central' ? 'central' : 'chat' }
    }
    // First run after the move from the bottom panel: an open Chat or Central tab reopens here,
    // and the old keys go so nothing reads them again.
    const chat = localStorage.getItem(LEGACY_CHAT_OPEN_KEY) === '1'
    const central = localStorage.getItem(LEGACY_CENTRAL_OPEN_KEY) === '1'
    localStorage.removeItem(LEGACY_CHAT_OPEN_KEY)
    localStorage.removeItem(LEGACY_CENTRAL_OPEN_KEY)
    const migrated: SideBarState = { open: chat || central, view: chat || !central ? 'chat' : 'central' }
    localStorage.setItem(SIDE_BAR_KEY, JSON.stringify(migrated))
    return migrated
  } catch {
    // Storage unavailable (private mode) or a corrupt value: start closed.
    return CLOSED
  }
}

let state: SideBarState = readStored()
const listeners = new Set<() => void>()

/** Change the open state and/or the shown view; persisted when storage is available. */
export function setSideBar(next: Partial<SideBarState>): void {
  state = { ...state, ...next }
  try {
    localStorage.setItem(SIDE_BAR_KEY, JSON.stringify(state))
  } catch {
    // Private mode: the layout lasts for this tab only.
  }
  listeners.forEach((listener) => listener())
}

/** ⌥⌘B / title-bar button: show or hide the side bar on its last view. */
export function toggleSideBar(): void {
  setSideBar({ open: !state.open })
}

/** Activity-bar semantics (as the bottom panel): closed opens `view`, another view shown switches, `view` shown closes. */
export function toggleSideBarView(view: SideBarView): void {
  if (state.open && state.view === view) setSideBar({ open: false })
  else setSideBar({ open: true, view })
}

// The Central chat's Needs-you strip: expanded or not. Lives here (not in the strip) so `/approvals`,
// the Dock's Central icon and the morning brief can expand it before the lazy chat pane mounted.
// Not persisted: a reload starts collapsed.
let needsYouExpanded = false

/** Expand or collapse the Needs-you strip. */
export function setNeedsYouExpanded(expanded: boolean): void {
  needsYouExpanded = expanded
  listeners.forEach((listener) => listener())
}

/** Show the side bar on Chat with the Needs-you strip expanded (`/approvals`, morning brief). */
export function expandNeedsYou(): void {
  needsYouExpanded = true
  setSideBar({ open: true, view: 'chat' })
}

export function useNeedsYouExpanded(): boolean {
  return useSyncExternalStore(subscribe, () => needsYouExpanded)
}

/** Activity-bar Central icon: with items waiting it opens on the expanded strip; otherwise a plain toggle. */
export function toggleChatView(waiting: number): void {
  if (waiting > 0 && !(state.open && state.view === 'chat')) expandNeedsYou()
  else toggleSideBarView('chat')
}

/** Test seam: reload from storage (runs the migration again when the key is absent). */
export function reloadSideBarFromStorage(): void {
  state = readStored()
  sideBarWidth.reload()
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Sub-tabs of the Central control panel. */
export type CentralTab = 'status' | 'abilities' | 'agents' | 'skills'
/** The last "show this Central tab" request; `seq` makes a repeat of the same tab a new request. */
export interface CentralTabRequest { tab: CentralTab; seq: number; halt?: boolean }
let centralRequest: CentralTabRequest | null = null

/** Opens the side bar on the Central view at `tab` (Central chat commands); `halt` also asks the kill-switch confirmation. */
export function openCentralTab(tab: CentralTab, halt = false): void {
  centralRequest = { tab, seq: (centralRequest?.seq ?? 0) + 1, ...(halt ? { halt } : {}) }
  setSideBar({ open: true, view: 'central' })
}

/** The latest `openCentralTab` request (not persisted: a reload starts on the panel's default tab). */
export function useCentralTabRequest(): CentralTabRequest | null {
  return useSyncExternalStore(subscribe, () => centralRequest)
}

export function useSideBar(): SideBarState {
  return useSyncExternalStore(subscribe, () => state)
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

/** True while the window is too narrow to dock the side bar beside the canvas. */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth < SIDE_BAR_OVERLAY_BREAKPOINT)
}
