import { Handle, Position, useNodeId, useStore } from '@xyflow/react'
import { MAX_ATTACHED_SKILLS, SKILLS_IN } from '../shared/skillPorts'
import { SN } from './skillNode.labels'
import './skillNode.css'

/**
 * The typed `skill` input on the bottom of a Claude agent (AgentNode, AgentChatNode): a diamond labelled "Skills"
 * with the attached count ("3/8"). Only a skill node's output may connect here (`skillConnection`,
 * docs/decisions/skill-canvas-nodes.md). At the cap it says why a drop would do nothing, instead of failing silently.
 * Rendered outside the clipped node frame so it stays whole.
 */
export function SkillsInPort() {
  const nodeId = useNodeId()
  const count = useStore((s) => s.edges.filter((e) => e.target === nodeId && (e.data as { kind?: string } | undefined)?.kind === 'skill').length)
  const full = count >= MAX_ATTACHED_SKILLS
  return (
    <>
      <Handle id={SKILLS_IN} type="target" position={Position.Bottom} className={`bridge-handle skill-handle${full ? ' skill-handle--full' : ''}`}
        aria-label={full ? SN.skillsPortFullAria(MAX_ATTACHED_SKILLS) : SN.skillsPortAria(count, MAX_ATTACHED_SKILLS)} />
      <span className={`skill-port-label${count ? ' skill-port-label--count' : ''}${full ? ' skill-port-label--full' : ''}`} aria-hidden="true">
        {SN.skillsPort}{count ? ` ${SN.portCount(count, MAX_ATTACHED_SKILLS)}` : ''}
        {full && <span className="skill-port-label__why">{SN.portFull(MAX_ATTACHED_SKILLS)}</span>}
      </span>
    </>
  )
}
