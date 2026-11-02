// Shared height of the VS Code bottom panel (Inbox and Chat are views of one panel, so they
// resize together). The height lives in module state, persists under `webterm.panelHeight`,
// and is published as the `--bottom-panel-h` custom property on <html> so the stacked-chat
// offset in `inboxPanelSurface.css` stays correct. `null` means "default": 40% of the window.
import { useEffect, useSyncExternalStore } from 'react'

/** localStorage key for the user-chosen panel height in px (absent = default 40%). */
export const PANEL_HEIGHT_KEY = 'webterm.panelHeight'
/** VS Code `Constants.PANEL_MIN_HEIGHT`-equivalent: the panel never collapses below this. */
export const PANEL_MIN_HEIGHT = 77
const PANEL_MAX_RATIO = 0.8
const PANEL_DEFAULT_RATIO = 0.4
/** Sash keyboard steps in px: plain arrow, and arrow with Shift. */
export const SASH_STEP = 10
export const SASH_STEP_LARGE = 50

export interface PanelHeightState {
  /** User-chosen px height, or null for the 40% default. */
  height: number | null
  maximized: boolean
}

let state: PanelHeightState = { height: readStored(), maximized: false }
const listeners = new Set<() => void>()

function readStored(): number | null {
  try {
    const raw = window.localStorage.getItem(PANEL_HEIGHT_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function persist(height: number | null): void {
  try {
    if (height === null) window.localStorage.removeItem(PANEL_HEIGHT_KEY)
    else window.localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // Storage can be unavailable (private mode); the height then lasts for the session only.
  }
}

function emit(next: PanelHeightState): void {
  state = next
  listeners.forEach((listener) => listener())
}

/** Largest panel height the window allows. */
export function panelMaxHeight(): number {
  return Math.max(PANEL_MIN_HEIGHT, Math.floor(window.innerHeight * PANEL_MAX_RATIO))
}

/** Clamp a requested height into [PANEL_MIN_HEIGHT, 80% of the window]. */
export function clampPanelHeight(height: number): number {
  return Math.min(panelMaxHeight(), Math.max(PANEL_MIN_HEIGHT, Math.round(height)))
}

/** The px height currently shown, resolving the 40% default. */
export function currentPanelHeight(): number {
  if (state.maximized) return panelMaxHeight()
  return clampPanelHeight(state.height ?? window.innerHeight * PANEL_DEFAULT_RATIO)
}

/** Set (and persist) a new height; leaves maximized mode. */
export function setPanelHeight(height: number): void {
  const next = clampPanelHeight(height)
  persist(next)
  emit({ height: next, maximized: false })
}

/** Toggle between the stored height and the 80% maximum; does not touch storage. */
export function togglePanelMaximized(): void {
  emit({ ...state, maximized: !state.maximized })
}

/** Forget the stored height (double-click on the sash restores the 40% default). */
export function resetPanelHeight(): void {
  persist(null)
  emit({ height: null, maximized: false })
}

/** Test seam: reset module state to what storage holds. */
export function reloadPanelHeightFromStorage(): void {
  emit({ height: readStored(), maximized: false })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Subscribe to the shared panel height and mirror it to `--bottom-panel-h` on <html>. */
export function usePanelHeight(): PanelHeightState {
  const current = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    const root = document.documentElement.style
    if (current.height === null && !current.maximized) root.removeProperty('--bottom-panel-h')
    else root.setProperty('--bottom-panel-h', `${currentPanelHeight()}px`)
  }, [current])
  return current
}

/** Height after a sash keyboard key, or null when the key is not a sash key. */
export function heightAfterKey(key: string, shift: boolean, from: number): number | null {
  const step = shift ? SASH_STEP_LARGE : SASH_STEP
  switch (key) {
    case 'ArrowUp': return clampPanelHeight(from + step)
    case 'ArrowDown': return clampPanelHeight(from - step)
    case 'Home': return PANEL_MIN_HEIGHT
    case 'End': return panelMaxHeight()
    default: return null
  }
}
