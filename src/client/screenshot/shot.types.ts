// Pure data types of the screenshot annotator. All coordinates are IMAGE pixels (the captured frame),
// never screen pixels, so a full-resolution export draws the same shapes as the preview.

/** A point in image pixels. */
export interface Point { x: number; y: number }

/** An axis-aligned box in image pixels. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Image bounds (origin 0,0). */
export interface Size { w: number; h: number }

/** Drawing tools the toolbar offers. */
export type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'marker' | 'text'

interface Stroke { color: string; width: number }

/** Freehand stroke through `points` (smoothed at render time). */
export interface PenShape extends Stroke { kind: 'pen'; points: Point[] }
/** Thick semi-transparent highlighter stroke through `points`. */
export interface MarkerShape extends Stroke { kind: 'marker'; points: Point[] }
/** Straight segment, or the same with an arrow head at `to`. */
export interface LineShape extends Stroke { kind: 'line' | 'arrow'; from: Point; to: Point }
/** Rectangle outline spanning the two corner points `from` and `to`. */
export interface RectShape extends Stroke { kind: 'rect'; from: Point; to: Point }
/** Text anchored at its top-left `at`; `size` is the font size in image pixels. */
export interface TextShape { kind: 'text'; color: string; at: Point; text: string; size: number; background?: boolean }

/** One annotation. */
export type Shape = PenShape | MarkerShape | LineShape | RectShape | TextShape

/** Undo/redo state: `shapes` in paint order, `redone` holds undone shapes (last undone is last). */
export interface ShotState { shapes: Shape[]; redone: Shape[] }

/** The eight selection resize handles. */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Typed result of copying to the clipboard. */
export type CopyResult = 'ok' | 'unsupported' | 'denied' | 'failed'
