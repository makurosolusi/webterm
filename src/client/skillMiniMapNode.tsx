import { memo } from 'react'
import { useStore } from '@xyflow/react'
import type { MiniMapNodeProps } from '@xyflow/react'
import { SKILL_KIND } from '../shared/skillPorts'

/** Mini-map shape of a node: a circle for a skill (like on the canvas), the usual rounded rectangle for everything else. */
function MiniMapNode({ id, x, y, width, height, borderRadius, className, color, shapeRendering, strokeColor, strokeWidth, style, onClick, selected }: MiniMapNodeProps) {
  const isSkill = useStore((s) => s.nodeLookup.get(id)?.type === SKILL_KIND)
  const fill = (style?.fill as string | undefined) ?? color
  const common = { className: ['react-flow__minimap-node', selected ? 'selected' : '', className].filter(Boolean).join(' '), fill, stroke: strokeColor, strokeWidth, shapeRendering, onClick: onClick ? (e: React.MouseEvent) => onClick(e, id) : undefined }
  if (isSkill) return <circle {...common} cx={x + width / 2} cy={y + height / 2} r={Math.min(width, height) / 2} data-shape="skill" />
  return <rect {...common} x={x} y={y} rx={borderRadius} ry={borderRadius} width={width} height={height} />
}
export const SkillAwareMiniMapNode = memo(MiniMapNode)
