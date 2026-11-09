// Width of the left side bar (Layers + Sessions). Same generic store as the bottom panel and the
// secondary side bar (`panelSize.ts`); mirrored as `--ss-w` on <html>, which `.app-shell--sidebar`
// uses as its grid column (the stylesheet default is 300px).
import { createPanelSize } from './panelSize'

export const SIDE_BAR_LEFT_WIDTH_KEY = 'webterm.sessionsWidth'
export const SIDE_BAR_LEFT_MIN_WIDTH = 220
export const SIDE_BAR_LEFT_DEFAULT_WIDTH = 300

export const sessionsPanelWidth = createPanelSize({
  key: SIDE_BAR_LEFT_WIDTH_KEY,
  cssVar: '--ss-w',
  min: SIDE_BAR_LEFT_MIN_WIDTH,
  maxRatio: 0.4,
  defaultSize: () => SIDE_BAR_LEFT_DEFAULT_WIDTH,
  viewport: () => window.innerWidth,
  // The sash is on the right edge, facing the canvas: right widens.
  growKey: 'ArrowRight',
  shrinkKey: 'ArrowLeft',
})
