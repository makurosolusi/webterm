// Shared height of the VS Code bottom panel (every bottom view is a tab of one panel, so they
// resize together). Persists under `webterm.panelHeight` and is mirrored as `--bottom-panel-h` on
// <html> so the docked canvas in `tab-layout.css` ends where the panel starts. Default: 40% of
// the window. The store itself is the generic `panelSize.ts`, shared with the secondary side bar.
import { createPanelSize, type PanelSizeState } from './panelSize'

export { SASH_STEP, SASH_STEP_LARGE } from './panelSize'

/** localStorage key for the user-chosen panel height in px (absent = default 40%). */
export const PANEL_HEIGHT_KEY = 'webterm.panelHeight'
/** VS Code `Constants.PANEL_MIN_HEIGHT`-equivalent: the panel never collapses below this. */
export const PANEL_MIN_HEIGHT = 77

export const bottomPanelHeight = createPanelSize({
  key: PANEL_HEIGHT_KEY,
  cssVar: '--bottom-panel-h',
  min: PANEL_MIN_HEIGHT,
  maxRatio: 0.8,
  defaultSize: () => window.innerHeight * 0.4,
  viewport: () => window.innerHeight,
  growKey: 'ArrowUp',
  shrinkKey: 'ArrowDown',
})

/** Largest panel height the window allows. */
export const panelMaxHeight = bottomPanelHeight.max
/** Clamp a requested height into [PANEL_MIN_HEIGHT, 80% of the window]. */
export const clampPanelHeight = bottomPanelHeight.clamp
/** The px height currently shown, resolving the 40% default. */
export const currentPanelHeight = bottomPanelHeight.current
/** Set (and persist) a new height; leaves maximized mode. */
export const setPanelHeight = bottomPanelHeight.set
/** Toggle between the stored height and the 80% maximum; does not touch storage. */
export const togglePanelMaximized = bottomPanelHeight.toggleMaximized
/** Forget the stored height (double-click on the sash restores the 40% default). */
export const resetPanelHeight = bottomPanelHeight.reset
/** Test seam: reset module state to what storage holds. */
export const reloadPanelHeightFromStorage = bottomPanelHeight.reload
/** Height after a sash keyboard key, or null when the key is not a sash key. */
export const heightAfterKey = bottomPanelHeight.afterKey
/** Subscribe to the shared panel height and mirror it to `--bottom-panel-h` on <html>. */
export const usePanelHeight = (): PanelSizeState => bottomPanelHeight.use()
