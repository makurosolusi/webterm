import { useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, useStore } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { IconButton } from '@/components/ui/icon-button'
import { SN } from './skillNode.labels'
import { isWarnStatus } from './skillNode.model'
import { useSkillStatus } from './skillNode.status'
import { SKILL_EDGE_MIN_HIT, SKILL_EDGE_STROKE, SKILL_EDGE_WIDTH, SKILL_EDGE_WIDTH_HOT } from './skillCable.style'
import './skillNode.css'

const titleOf = (n: { data?: unknown } | undefined, fallback: string): string => {
  const d = n?.data as { title?: string; skill?: string; agentId?: string } | undefined
  return d?.title || d?.skill || d?.agentId || fallback
}

/**
 * Cable of kind `skill`: from the skill node's top port to the agent's bottom Skills port. Unlike the floating
 * context cable it follows the real handle positions, because the ports are typed and fixed. Thin accent dashes
 * (a warning colour when the skill is unavailable), thicker on hover / selection, with a detach button that is
 * reachable by keyboard. Colour, width and dashes come from skillNode.css, so the generic inline style is dropped.
 */
export default function SkillEdge(p: EdgeProps) {
  const rf = useReactFlow()
  const [hover, setHover] = useState(false)
  const warn = isWarnStatus(useSkillStatus(p.source))
  const names = useStore((s) => `${titleOf(s.nodeLookup.get(p.source), 'skill')}\n${titleOf(s.nodeLookup.get(p.target), 'agent')}`)
  const [skill, host] = names.split('\n')
  const [path, labelX, labelY] = getBezierPath({
    sourceX: p.sourceX, sourceY: p.sourceY, sourcePosition: p.sourcePosition,
    targetX: p.targetX, targetY: p.targetY, targetPosition: p.targetPosition,
  })
  const detach = () => { void rf.deleteElements({ edges: [{ id: p.id }] }) }
  const hot = hover || !!p.selected
  return (
    <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} aria-label={SN.edgeAria(skill, host)}>
      <BaseEdge id={p.id} path={path} className={`skill-edge-path${warn ? ' skill-edge-path--warn' : ''}`} data-hot={hot}
        // Settings › Skill cable color / size. Warning color stays the stylesheet's (above the chosen color); the hit area never drops below the minimum.
        style={{ ...(warn ? null : { stroke: SKILL_EDGE_STROKE }), strokeWidth: hot ? SKILL_EDGE_WIDTH_HOT : SKILL_EDGE_WIDTH }}
        interactionWidth={Math.max(SKILL_EDGE_MIN_HIT, p.interactionWidth ?? 0)} />
      <EdgeLabelRenderer>
        <div className="skill-edge__tools nodrag nopan" data-shown={hot} style={{ left: labelX, top: labelY }}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          {warn && <span className="skill-edge__warn" role="status">{SN.edgeWarn}</span>}
          <IconButton label={SN.edgeDetach} size="icon-xs" variant="secondary" side="top" onClick={detach}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </IconButton>
        </div>
      </EdgeLabelRenderer>
    </g>
  )
}
