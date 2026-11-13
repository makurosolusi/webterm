import type { Terminal } from '@xterm/xterm'
import type { TermSize } from './terminalSizing'

/** Same floor as `@xterm/addon-fit` (`MINIMUM_COLS`/`MINIMUM_ROWS`). */
const MIN_COLS = 2
const MIN_ROWS = 1
/** Cell sizes are fractional (e.g. 7.8000001 px); without slack, a host that is an exact multiple of
 *  the cell drops a whole column to floating-point noise. */
const CELL_EPSILON = 1e-6

export interface FitInput {
  /** Host content box, CSS px (unscaled layout px, so canvas zoom does not matter). */
  width: number
  height: number
  /** Padding of the `.xterm` element; the grid lives inside it. */
  padding: { top: number; right: number; bottom: number; left: number }
  cell: { width: number; height: number }
}

/** Grid that fills the host exactly: every whole cell that fits inside the padded box. Unlike
 *  addon-fit, no width is reserved for a scrollbar: xterm 6 draws an overlay scrollbar
 *  (`SmoothScrollableElement`) that takes no layout width, so addon-fit's 14 px reserve was about
 *  two columns of empty space on the right of every terminal. */
export function fitGeometry({ width, height, padding, cell }: FitInput): TermSize | undefined {
  if (!(cell.width > 0) || !(cell.height > 0)) return undefined
  const w = Math.max(0, width - padding.left - padding.right)
  const h = Math.max(0, height - padding.top - padding.bottom)
  return {
    cols: Math.max(MIN_COLS, Math.floor(w / cell.width + CELL_EPSILON)),
    rows: Math.max(MIN_ROWS, Math.floor(h / cell.height + CELL_EPSILON)),
  }
}

interface RenderService { dimensions: { css: { cell: FitInput['cell'] } }; clear(): void }
// TODO(xterm): private API, the same one addon-fit reads (`FitAddon.ts:41,62`); drop this module and
// go back to addon-fit once it stops reserving a scrollbar for the overlay viewport.
const renderService = (term: Terminal) => (term as unknown as { _core: { _renderService: RenderService } })._core._renderService

const px = (s: CSSStyleDeclaration, k: string) => parseFloat(s.getPropertyValue(k)) || 0

/** `fitGeometry` for a live terminal opened inside `host`; undefined before xterm has measured a cell. */
export function proposeTerminalSize(term: Terminal, host: HTMLElement): TermSize | undefined {
  if (!term.element) return undefined
  const cell = renderService(term).dimensions.css.cell
  const s = getComputedStyle(term.element)
  return fitGeometry({
    width: host.clientWidth,
    height: host.clientHeight,
    padding: { top: px(s, 'padding-top'), right: px(s, 'padding-right'), bottom: px(s, 'padding-bottom'), left: px(s, 'padding-left') },
    cell,
  })
}

/** Resize `term` to fill `host`. Callers gate on the host having a size (see `hasSize`). */
export function fitTerminal(term: Terminal, host: HTMLElement): void {
  const next = proposeTerminalSize(term, host)
  if (!next || (next.cols === term.cols && next.rows === term.rows)) return
  renderService(term).clear() // force a full render, as addon-fit does
  term.resize(next.cols, next.rows)
}
