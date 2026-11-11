// "Fit width to content" for an editor node: widen or narrow it so the longest line now visible in
// Monaco fits without horizontal scroll, like auto-fitting a spreadsheet column. Clamped so a
// minified line cannot make a huge node. Applied as a settled `dimensions` change, the same change a
// manual resize ends with, so it is saved and is one layout undo step.
import type { editor as MonacoEditor } from 'monaco-editor'
import type { ReactFlowState } from '@xyflow/react'
import { getNodeResizeState } from './nodeResize/nodeResize.store'
import { getTabLayout } from './tabLayout.store'

export const FIT_MAX_COLS = 120
/** Breathing room after the last character, so the caret at line end does not trigger a scrollbar. */
const FIT_SLACK_PX = 16

export interface FitInput {
  /** Visual columns of the longest visible line (tabs expanded). */
  cols: number
  charWidth: number
  /** Node width minus the editor's width: header-less chrome around Monaco (borders, padding). */
  chrome: number
  /** Gutter: line numbers, glyph margin, folding (layoutInfo.contentLeft). */
  contentLeft: number
  /** Minimap plus vertical scrollbar width. */
  reserved: number
  minWidth: number
  /** Visible canvas width in screen px and the current zoom. */
  viewportWidth: number
  zoom: number
}

/** Node width (flow units) that fits `cols` columns, clamped to [minWidth, min(120 cols, visible canvas)]. */
export function fitWidth(i: FitInput): number {
  const forCols = (cols: number) => i.chrome + i.contentLeft + cols * i.charWidth + i.reserved + FIT_SLACK_PX
  const max = Math.min(forCols(FIT_MAX_COLS), i.viewportWidth / i.zoom)
  return Math.round(Math.max(i.minWidth, Math.min(forCols(i.cols), max)))
}

/** Longest visual line among the lines Monaco shows right now; 0 without a model. */
export function longestVisibleCols(editor: Pick<MonacoEditor.ICodeEditor, 'getModel' | 'getVisibleRanges'>): number {
  const model = editor.getModel()
  if (!model) return 0
  const tab = model.getOptions().tabSize
  let max = 0
  for (const r of editor.getVisibleRanges()) {
    for (let l = r.startLineNumber; l <= r.endLineNumber; l++) {
      const text = model.getLineContent(l)
      // ponytail: tabs only; wide (CJK/emoji) glyphs count as one column, measure rendered width if it matters.
      const cols = text.length + (text.split('\t').length - 1) * (tab - 1)
      if (cols > max) max = cols
    }
  }
  return max
}

/** Why fitting is off right now, or null when it can run. */
export function fitRefusal(wrap: boolean): string | null {
  if (wrap) return 'Word wrap is on'
  if (getNodeResizeState().locked || getTabLayout().mode === 'tabs') return 'The view is locked'
  return null
}

type FitStore = Pick<ReactFlowState, 'nodeLookup' | 'transform' | 'width' | 'triggerNodeChanges'>
type FitEditor = Pick<MonacoEditor.ICodeEditor, 'getModel' | 'getVisibleRanges' | 'getLayoutInfo'>

/** Resize node `id` to fit `editor`'s visible lines (`charWidth` = fontInfo.typicalHalfwidthCharacterWidth); height unchanged. */
export function fitNodeWidth(s: FitStore, id: string, editor: FitEditor, charWidth: number, minWidth: number): boolean {
  const node = s.nodeLookup.get(id)
  const width = node?.measured.width ?? node?.width
  const height = node?.measured.height ?? node?.height
  if (!node || width === undefined || height === undefined) return false
  const layout = editor.getLayoutInfo()
  const next = fitWidth({
    cols: longestVisibleCols(editor),
    charWidth,
    chrome: Math.max(0, width - layout.width),
    contentLeft: layout.contentLeft,
    reserved: layout.minimap.minimapWidth + layout.verticalScrollbarWidth,
    minWidth,
    viewportWidth: s.width,
    zoom: s.transform[2],
  })
  if (next === Math.round(width)) return false
  s.triggerNodeChanges([{ id, type: 'dimensions', resizing: false, setAttributes: 'width', dimensions: { width: next, height } }])
  return true
}
