import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

/**
 * Cable of kind `skill`: from the skill node's top port to the agent's bottom Skills port. Unlike the floating
 * context cable it follows the real handle positions, because the ports are typed and fixed. Styling (dashed,
 * thin, no arrows) comes from `decorateEdges`.
 */
export default function SkillEdge(p: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: p.sourceX, sourceY: p.sourceY, sourcePosition: p.sourcePosition,
    targetX: p.targetX, targetY: p.targetY, targetPosition: p.targetPosition,
  })
  return (
    <BaseEdge id={p.id} path={path} style={p.style} label={p.label} labelX={labelX} labelY={labelY} labelStyle={p.labelStyle}
      labelShowBg labelBgStyle={p.labelBgStyle} labelBgPadding={[6, 3]} labelBgBorderRadius={3} interactionWidth={p.interactionWidth} />
  )
}
