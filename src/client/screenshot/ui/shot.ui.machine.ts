// State machine of the screenshot annotator (pure reducer, no DOM):
//   idle -> capturing -> selecting -> selected -> copying | saving -> idle ("closed"; a failed export returns to selected).
// Every failure becomes `notice` (kind 'error' with the way out), never a silent no-op.
import { canRedo, canUndo, addShape, emptyState, redo, undo } from '../shot.model'
import { DEFAULT_COLOR, DEFAULT_TEXT_SIZE, DEFAULT_WIDTH, MARKER_DEFAULT_COLOR } from '../shot.palette'
import { isSelectionValid } from '../shot.selection'
import type { ShotFrame } from '../shot.render'
import type { CaptureFailure } from '../shot.capture'
import type { CopyResult, Rect, Shape, ShotState, Size, Tool } from '../shot.types'
import { SHOT_TEXT } from './shot.ui.text'

export type Phase = 'idle' | 'capturing' | 'selecting' | 'selected' | 'copying' | 'saving'
export type ExportKind = 'copy' | 'save'

export interface ShotNotice {
  /** Increases per notice, so the host can show the same text twice. */
  id: number
  kind: 'info' | 'error'
  title: string
  message?: string
  /** The way out offered with an error: save instead of copy, or capture again. */
  action?: 'save' | 'retry'
}

export interface UiState {
  phase: Phase
  frame: ShotFrame | null
  /** Viewport size in CSS px, and image pixels per CSS px. */
  css: Size
  scale: number
  /** Selection (image px); while `selecting` it is the live drag rectangle. */
  selection: Rect | null
  tool: Tool | null
  color: string
  width: number
  textSize: number
  shots: ShotState
  notice: ShotNotice | null
  /** Last notice id handed out; survives resets so ids only grow. */
  noticeSeq: number
}

export interface Prefs { color: string; width: number; textSize: number }

export const initialState = (prefs?: Partial<Prefs>): UiState => ({
  phase: 'idle', frame: null, css: { w: 0, h: 0 }, scale: 1, selection: null, tool: null,
  color: prefs?.color ?? DEFAULT_COLOR, width: prefs?.width ?? DEFAULT_WIDTH, textSize: prefs?.textSize ?? DEFAULT_TEXT_SIZE,
  shots: emptyState(), notice: null, noticeSeq: 0,
})

export type UiAction =
  | { type: 'start' }
  | { type: 'captured'; frame: ShotFrame; css: Size; scale: number }
  | { type: 'captureFailed'; reason: CaptureFailure }
  | { type: 'dragSelection'; rect: Rect }
  | { type: 'commitSelection'; rect: Rect }
  | { type: 'setSelection'; rect: Rect }
  | { type: 'selectAll' }
  | { type: 'setTool'; tool: Tool | null }
  | { type: 'setColor'; color: string }
  | { type: 'setWidth'; width: number }
  | { type: 'setTextSize'; size: number }
  | { type: 'addShape'; shape: Shape }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'exportStart'; kind: ExportKind }
  | { type: 'exportDone'; kind: ExportKind; result: CopyResult; name?: string }
  | { type: 'close' }
  | { type: 'dismissNotice' }

const hasSelection = (s: UiState): boolean => s.phase === 'selected'
const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })
/** `s` with notice `n` shown (a fresh id each time, so the same text twice is shown twice). */
const withNotice = (s: UiState, n: Omit<ShotNotice, 'id'>): UiState => ({ ...s, noticeSeq: s.noticeSeq + 1, notice: { id: s.noticeSeq + 1, ...n } })
const withError = (s: UiState, key: keyof typeof SHOT_TEXT.errors, action?: ShotNotice['action']): UiState =>
  withNotice(s, { kind: 'error', ...SHOT_TEXT.errors[key], action })

const COPY_ERROR: Record<Exclude<CopyResult, 'ok'>, keyof typeof SHOT_TEXT.errors> = {
  denied: 'copyDenied', unsupported: 'copyUnsupported', failed: 'copyFailed',
}

/** Marker starts yellow and the rest red, but only while the color is still the other tool's untouched default. */
function colorFor(color: string, from: Tool | null, to: Tool | null): string {
  if (to === 'marker' && color === DEFAULT_COLOR) return MARKER_DEFAULT_COLOR
  if (from === 'marker' && to !== 'marker' && color === MARKER_DEFAULT_COLOR) return DEFAULT_COLOR
  return color
}

export function shotReducer(s: UiState, a: UiAction): UiState {
  switch (a.type) {
    case 'start':
      // One instance at a time: a second start while anything is open or running is ignored.
      return s.phase === 'idle' ? { ...initialState(s), noticeSeq: s.noticeSeq, phase: 'capturing' } : s
    case 'captured':
      return s.phase === 'capturing' ? { ...s, phase: 'selecting', frame: a.frame, css: a.css, scale: a.scale, notice: null } : s
    case 'captureFailed':
      return s.phase === 'capturing' ? withError({ ...s, phase: 'idle' }, a.reason, a.reason === 'busy' ? undefined : 'retry') : s
    case 'dragSelection':
      return s.phase === 'selecting' ? { ...s, selection: a.rect } : s
    case 'commitSelection': {
      if (s.phase !== 'selecting') return s
      const rect = round(a.rect)
      return isSelectionValid(rect) ? { ...s, phase: 'selected', selection: rect } : { ...s, selection: null }
    }
    case 'setSelection':
      return hasSelection(s) ? { ...s, selection: round(a.rect) } : s
    case 'selectAll':
      return s.phase === 'selecting' && s.frame ? { ...s, phase: 'selected', selection: { x: 0, y: 0, w: s.frame.width, h: s.frame.height } } : s
    case 'setTool':
      return hasSelection(s) ? { ...s, tool: a.tool, color: colorFor(s.color, s.tool, a.tool) } : s
    case 'setColor': return hasSelection(s) ? { ...s, color: a.color } : s
    case 'setWidth': return hasSelection(s) ? { ...s, width: a.width } : s
    case 'setTextSize': return hasSelection(s) ? { ...s, textSize: a.size } : s
    case 'addShape': return hasSelection(s) ? { ...s, shots: addShape(s.shots, a.shape) } : s
    case 'undo': return hasSelection(s) && canUndo(s.shots) ? { ...s, shots: undo(s.shots) } : s
    case 'redo': return hasSelection(s) && canRedo(s.shots) ? { ...s, shots: redo(s.shots) } : s
    case 'exportStart':
      return hasSelection(s) && s.selection ? { ...s, phase: a.kind === 'copy' ? 'copying' : 'saving', notice: null } : s
    case 'exportDone': {
      if (s.phase !== 'copying' && s.phase !== 'saving') return s
      if (a.result === 'ok') {
        const title = a.kind === 'copy' ? SHOT_TEXT.copied : SHOT_TEXT.saved(a.name ?? '')
        return withNotice({ ...initialState(s), noticeSeq: s.noticeSeq }, { kind: 'info', title })
      }
      // Stay open so the work is not lost; a failed copy offers Save, a failed save can be retried by its button.
      const next: UiState = { ...s, phase: 'selected' }
      return a.kind === 'copy' ? withError(next, COPY_ERROR[a.result], 'save') : withError(next, 'saveFailed')
    }
    // Capture cannot be cancelled and an export in flight finishes first, so those phases ignore close.
    case 'close': return s.phase !== 'selecting' && s.phase !== 'selected' ? s : { ...initialState(s), noticeSeq: s.noticeSeq }
    case 'dismissNotice': return s.notice ? { ...s, notice: null } : s
  }
}
