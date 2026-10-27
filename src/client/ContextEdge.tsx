import { BaseEdge, getBezierPath, useInternalNode } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { floatingEdgeParams, rectOf } from './floatingEdge'

export default function FloatingEdge(props: EdgeProps) {
  const a = rectOf(useInternalNode(props.source))
  const b = rectOf(useInternalNode(props.target))
  if (!a || !b) return null
  const p = floatingEdgeParams(a, b)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: p.sx, sourceY: p.sy, sourcePosition: p.sourcePosition,
    targetX: p.tx, targetY: p.ty, targetPosition: p.targetPosition,
  })
  return (
    <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd}
      markerStart={props.markerStart} label={props.label} labelX={labelX} labelY={labelY}
      labelStyle={props.labelStyle} labelShowBg labelBgStyle={props.labelBgStyle}
      labelBgPadding={[6, 3]} labelBgBorderRadius={5} interactionWidth={props.interactionWidth} />
  )
}
