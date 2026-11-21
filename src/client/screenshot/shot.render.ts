// Draws a frame plus annotations onto one 2D context; used by the live preview AND the export.
import {
  ARROW_HEAD_ANGLE, ARROW_HEAD_FACTOR, ARROW_HEAD_MIN_PX, MARKER_ALPHA, MARKER_WIDTH_FACTOR,
  SHOT_FONT, TEXT_BG_PADDING_PX, TEXT_LINE_HEIGHT,
} from './shot.palette'
import type { LineShape, Point, Rect, Shape, TextShape } from './shot.types'

/** A drawable image with known pixel size (canvas or ImageBitmap). */
export type ShotFrame = CanvasImageSource & { width: number; height: number }

export interface RenderOptions {
  /** Crop area in frame pixels; the whole frame when omitted. */
  selection?: Rect
  /** Output pixels per frame pixel (1 = full resolution); preview passes its display ratio. */
  scale?: number
}

/** Smooth path through points: quadratic curves via midpoints, so strokes are curves, not polylines. */
function tracePath(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 1) { ctx.lineTo(pts[0].x, pts[0].y); return }
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
}

/** Corner points of the arrow head at `to`, and the shaft end (the head's base middle). */
export function arrowGeometry(s: Pick<LineShape, 'from' | 'to' | 'width'>): { left: Point; right: Point; base: Point } {
  const len = Math.max(ARROW_HEAD_MIN_PX, s.width * ARROW_HEAD_FACTOR)
  const ang = Math.atan2(s.to.y - s.from.y, s.to.x - s.from.x)
  const corner = (a: number): Point => ({ x: s.to.x - len * Math.cos(ang + a), y: s.to.y - len * Math.sin(ang + a) })
  const left = corner(-ARROW_HEAD_ANGLE), right = corner(ARROW_HEAD_ANGLE)
  return { left, right, base: { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 } }
}

/** Black or white overlay behind text, whichever contrasts with the text color (#rrggbb). */
export function textBackground(color: string): string {
  const n = Number.parseInt(color.replace('#', '').slice(0, 6), 16)
  const lum = Number.isFinite(n) ? (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 : 0
  return lum > 0.6 ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.8)'
}

function drawText(ctx: CanvasRenderingContext2D, s: TextShape): void {
  ctx.font = `${s.size}px ${SHOT_FONT}`
  ctx.textBaseline = 'top'
  const lines = s.text.split('\n')
  const lineH = s.size * TEXT_LINE_HEIGHT
  if (s.background) {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width))
    ctx.fillStyle = textBackground(s.color)
    ctx.fillRect(s.at.x - TEXT_BG_PADDING_PX, s.at.y - TEXT_BG_PADDING_PX, w + 2 * TEXT_BG_PADDING_PX, lines.length * lineH + 2 * TEXT_BG_PADDING_PX)
  }
  ctx.fillStyle = s.color
  lines.forEach((l, i) => ctx.fillText(l, s.at.x, s.at.y + i * lineH))
}

/** Paint one shape in frame coordinates. */
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.save()
  if (s.kind === 'text') { drawText(ctx, s); ctx.restore(); return }
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (s.kind === 'pen') {
    tracePath(ctx, s.points)
    ctx.stroke()
  } else if (s.kind === 'marker') {
    // One stroke for the whole path (self-overlap does not double up). Plain source-over at partial alpha:
    // visible on light and dark backgrounds (multiply vanishes on dark terminals), text below shows through.
    ctx.globalAlpha = MARKER_ALPHA
    ctx.lineCap = 'butt'
    ctx.lineWidth = s.width * MARKER_WIDTH_FACTOR
    tracePath(ctx, s.points)
    ctx.stroke()
  } else if (s.kind === 'rect') {
    ctx.lineJoin = 'miter'
    ctx.strokeRect(Math.min(s.from.x, s.to.x), Math.min(s.from.y, s.to.y), Math.abs(s.to.x - s.from.x), Math.abs(s.to.y - s.from.y))
  } else {
    const head = s.kind === 'arrow' ? arrowGeometry(s) : null
    ctx.beginPath()
    ctx.moveTo(s.from.x, s.from.y)
    ctx.lineTo((head ?? { base: s.to }).base.x, (head ?? { base: s.to }).base.y)
    ctx.stroke()
    if (head) {
      ctx.beginPath()
      ctx.moveTo(s.to.x, s.to.y)
      ctx.lineTo(head.left.x, head.left.y)
      ctx.lineTo(head.right.x, head.right.y)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.restore()
}

/** Draw the (cropped) frame and all shapes at (0,0) of `ctx`, scaled by `scale`; shapes are clipped to the crop. */
export function renderScene(ctx: CanvasRenderingContext2D, frame: ShotFrame, shapes: readonly Shape[], opts: RenderOptions = {}): void {
  const sel = opts.selection ?? { x: 0, y: 0, w: frame.width, h: frame.height }
  const scale = opts.scale ?? 1
  ctx.save()
  ctx.scale(scale, scale)
  ctx.drawImage(frame, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h)
  ctx.beginPath()
  ctx.rect(0, 0, sel.w, sel.h)
  ctx.clip()
  ctx.translate(-sel.x, -sel.y)
  for (const s of shapes) drawShape(ctx, s)
  ctx.restore()
}
