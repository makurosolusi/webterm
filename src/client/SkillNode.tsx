import { memo, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { Button } from '@/components/ui/button'
import { randomId } from './randomId'
import { FALLBACK_AGENT_COLOR } from '../shared/workspace'
import type { Comment } from '../shared/workspace'
import { SKILL_OUT } from '../shared/skillPorts'
import { useCanvasSkills } from './skillNode.api'
import { cardState, isUnavailable, versionChanged } from './skillNode.model'
import { SN } from './skillNode.labels'
import './skillNode.css'

const COLLAPSED_H = 44
const EXPANDED_H = 124

/**
 * A canvas skill on the board: a REFERENCE to a library skill by name (`data.skill`), cabled to an agent's Skills
 * port to attach it. It follows the active version, shows Unavailable when the skill is off or gone, and never
 * copies the instructions (docs/decisions/skill-canvas-nodes.md). Collapsed by default: a one-line card.
 */
function SkillNode({ id, data, selected, height }: NodeProps) {
  const d = data as { skill?: string; seenVersion?: string; color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const rf = useReactFlow()
  const library = useCanvasSkills()
  const state = cardState(library, d.skill)
  const collapsed = d.collapsed ?? true
  const swatch = d.color ?? FALLBACK_AGENT_COLOR
  const comments = d.comments ?? []
  const expandedH = useRef(EXPANDED_H)

  // First sight of the active version records it, so only a LATER change reads as "Updated".
  useEffect(() => {
    if (state.kind === 'active' && !d.seenVersion && state.version) rf.updateNodeData(id, { seenVersion: state.version })
  }, [state, d.seenVersion, rf, id])

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? EXPANDED_H; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const chip = state.kind === 'active' ? (
    <span className="skill-node__chips">
      <span className="skill-node__badge">{SN.version(state.version)}</span>
      {versionChanged(d.seenVersion, state.version) && d.seenVersion && (
        <Button type="button" size="xs" variant="secondary" className="skill-node__badge skill-node__badge--updated nodrag" aria-label={SN.updatedHint} onClick={() => rf.updateNodeData(id, { seenVersion: state.version })}>
          {SN.updated(d.seenVersion, state.version)}
        </Button>
      )}
    </span>
  ) : isUnavailable(state) || state.kind === 'off' ? <span className="skill-node__badge skill-node__badge--off">{SN.unavailable}</span> : null

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={220} minHeight={COLLAPSED_H} color={swatch} />
      <div className={termNodeClass({ selected: !!selected, collapsed })} style={{ '--node-swatch': swatch } as CSSProperties}>
        <NodeChrome
          title={d.title || d.skill || SN.nodeTitleFallback} name={d.name}
          icon="book"
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          statusChip={chip}
          comments={comments}
          onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          closeLabel="Remove skill node"
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        {!collapsed && (
          <div className="node-body skill-node__body">
            {state.kind === 'loading' && <p role="status">{SN.loading}</p>}
            {state.kind === 'error' && <p role="alert">{SN.loadFailed} <Button type="button" size="xs" variant="secondary" className="nodrag" onClick={library.reload}>{SN.retry}</Button></p>}
            {state.kind === 'off' && <p>{SN.unavailableOff}</p>}
            {state.kind === 'disabled' && <p>{SN.unavailableDisabled}</p>}
            {state.kind === 'missing' && <p>{SN.unavailableMissing}</p>}
            {state.kind === 'active' && <p className="skill-node__desc">{state.description || SN.noDescription}</p>}
          </div>
        )}
      </div>
      {/* Typed `skill` output on top: the cable runs up into an agent's Skills port (SkillEdge). */}
      <Handle id={SKILL_OUT} type="source" position={Position.Top} className="bridge-handle skill-handle" aria-label={SN.skillOutAria} />
    </>
  )
}

export default memo(SkillNode)
