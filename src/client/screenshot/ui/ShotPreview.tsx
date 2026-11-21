// The one preview canvas: the frozen frame, dimmed everywhere except the selection, which shows the crop
// with its annotations at display size. Redraws are coalesced to one per animation frame.
import { useEffect, useRef } from 'react'
import { renderScene, type ShotFrame } from '../shot.render'
import type { Rect, Shape, Size } from '../shot.types'
import { toCss } from './shot.ui.layout'

/** Darkening laid over the frozen page outside the selection. */
export const DIM_FILL = 'rgba(0, 0, 0, 0.55)'

export interface ShotPreviewProps {
  frame: ShotFrame
  css: Size
  scale: number
  selection: Rect | null
  shapes: readonly Shape[]
  /** The shape being drawn right now, if any. */
  draft: Shape | null
}

/** Paint the dimmed frame and the bright, annotated selection into `ctx` (CSS px, `dpr` backing ratio). */
export function paintPreview(ctx: CanvasRenderingContext2D, p: ShotPreviewProps, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, p.css.w, p.css.h)
  ctx.drawImage(p.frame, 0, 0, p.css.w, p.css.h)
  ctx.fillStyle = DIM_FILL
  ctx.fillRect(0, 0, p.css.w, p.css.h)
  if (!p.selection) return
  const box = toCss(p.selection, p.scale)
  ctx.save()
  ctx.translate(box.x, box.y)
  // The crop is drawn in CSS px: renderScene scales by output pixels per frame pixel, which is 1/scale here.
  renderScene(ctx, p.frame, p.draft ? [...p.shapes, p.draft] : p.shapes, { selection: p.selection, scale: 1 / p.scale })
  ctx.restore()
}

export function ShotPreview(props: ShotPreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const raf = useRef(0)
  const { frame, css, scale, selection, shapes, draft } = props

  useEffect(() => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const ctx = ref.current?.getContext('2d')
      if (ctx) paintPreview(ctx, latest.current, window.devicePixelRatio || 1)
    })
  }, [frame, css, scale, selection, shapes, draft])
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const dpr = window.devicePixelRatio || 1
  return <canvas ref={ref} className="shot-preview" aria-hidden width={Math.round(css.w * dpr)} height={Math.round(css.h * dpr)} style={{ width: css.w, height: css.h }} />
}
