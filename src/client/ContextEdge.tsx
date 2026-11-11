import { BaseEdge, getBezierPath, useInternalNode } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { floatingEdgeParams, rectOf } from './floatingEdge'
import { EDGE_WIDTH } from './canvasStyle'

/** Halo di bawah garis: lebih tebal sebesar ini supaya kabel terbaca di atas gambar/gradasi. */
const HALO_EXTRA_WIDTH = 3
const HALO_OPACITY = 0.6

export default function FloatingEdge(props: EdgeProps) {
  const a = rectOf(useInternalNode(props.source))
  const b = rectOf(useInternalNode(props.target))
  if (!a || !b) return null
  const p = floatingEdgeParams(a, b)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: p.sx, sourceY: p.sy, sourcePosition: p.sourcePosition,
    targetX: p.tx, targetY: p.ty, targetPosition: p.targetPosition,
  })
  const width = Number(props.style?.strokeWidth ?? EDGE_WIDTH)
  const haloWidth = width + HALO_EXTRA_WIDTH
  // Hover menambah `--edge-hover-extra` (canvas-ui.css), jadi selalu lebih tebal dari tebal pilihan.
  const style = { ...props.style, strokeWidth: `calc(${width}px + var(--edge-hover-extra, 0px))` }
  return (
    <>
    <path className="edge-halo" d={path} fill="none" stroke="var(--canvas-bg)" strokeWidth={haloWidth}
      strokeOpacity={HALO_OPACITY} style={{ pointerEvents: 'none' }} />
    <BaseEdge id={props.id} path={path} style={style} markerEnd={props.markerEnd}
      markerStart={props.markerStart} label={props.label} labelX={labelX} labelY={labelY}
      labelStyle={props.labelStyle} labelShowBg labelBgStyle={props.labelBgStyle}
      labelBgPadding={[6, 3]} labelBgBorderRadius={3} interactionWidth={props.interactionWidth} />
    </>
  )
}
