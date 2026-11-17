import { Handle, Position } from '@xyflow/react'
import { SKILLS_IN } from '../shared/skillPorts'
import { SN } from './skillNode.labels'
import './skillNode.css'

/**
 * The typed `skill` input on the bottom of a Claude agent (AgentNode, AgentChatNode): a diamond labelled "Skills".
 * Only a skill node's output may connect here (`skillConnection`, docs/decisions/skill-canvas-nodes.md). Rendered
 * outside the clipped node frame so it stays whole.
 */
export function SkillsInPort() {
  return (
    <>
      <Handle id={SKILLS_IN} type="target" position={Position.Bottom} className="bridge-handle skill-handle" aria-label={SN.skillsPortAria} />
      <span className="skill-port-label" aria-hidden="true">{SN.skillsPort}</span>
    </>
  )
}
