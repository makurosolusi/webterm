import { memo, useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { randomId } from './randomId'
import { FALLBACK_AGENT_COLOR } from '../shared/workspace'
import type { Comment } from '../shared/workspace'
import { SKILL_CARD_SIZE, SKILL_NODE_SIZE, SKILL_OUT } from '../shared/skillPorts'
import { SkillGlyph } from './SkillGlyph'
import { SkillToken } from './SkillToken'
import { useCanvasSkills } from './skillNode.api'
import { cardState, isWarnStatus, statusOf, versionChanged } from './skillNode.model'
import { setSkillStatus } from './skillNode.status'
import { SN } from './skillNode.labels'
import './skillNode.css'
import './skillNode.shape.css'

const EXPANDED_SIZE = SKILL_CARD_SIZE

/**
 * A canvas skill on the board: a REFERENCE to a library skill by name (`data.skill`), cabled to an agent's Skills
 * port to attach it. It follows the active version, shows Unavailable when the skill is off or gone, and never
 * copies the instructions (docs/decisions/skill-canvas-nodes.md). Collapsed by default = a round token (SkillToken),
 * expanded = a pill-radius card with the token's glyph as its avatar (docs/decisions/skill-node-shape.md).
 */
function SkillNode({ id, data, selected, width, height }: NodeProps) {
  const d = data as { skill?: string; seenVersion?: string; color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const rf = useReactFlow()
  const library = useCanvasSkills()
  const state = cardState(library, d.skill)
  const collapsed = d.collapsed ?? true
  const swatch = d.color ?? FALLBACK_AGENT_COLOR
  const comments = d.comments ?? []
  const expandedSize = useRef(EXPANDED_SIZE)

  // First sight of the active version records it, so only a LATER change reads as "Updated".
  useEffect(() => {
    if (state.kind === 'active' && !d.seenVersion && state.version) rf.updateNodeData(id, { seenVersion: state.version })
  }, [state, d.seenVersion, rf, id])

  const remove = () => { void rf.deleteElements({ nodes: [{ id }] }) }
  const toggleCollapse = () => {
    if (!collapsed) { expandedSize.current = { width: width ?? EXPANDED_SIZE.width, height: height ?? EXPANDED_SIZE.height }; rf.updateNode(id, SKILL_NODE_SIZE) }
    else rf.updateNode(id, expandedSize.current)
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  const status = statusOf(state)
  const warn = isWarnStatus(status)
  // Published for the cable (SkillEdge) and forgotten on unmount.
  useEffect(() => { setSkillStatus(id, status); return () => setSkillStatus(id, undefined) }, [id, status])
  // Hosts this skill is cabled to, as one primitive so the selector does not re-render the node on unrelated edge changes.
  const hostNames = useStore((s) => s.edges
    .filter((e) => e.source === id && (e.data as { kind?: string } | undefined)?.kind === 'skill')
    .map((e) => { const h = s.nodeLookup.get(e.target)?.data as { title?: string; agentId?: string } | undefined; return h?.title || h?.agentId || 'agent' })
    .join('\n'))
  const title = d.title || d.skill || SN.nodeTitleFallback
  const statusWord = status === 'active' ? SN.active : status === 'disabled' ? SN.disabled : status === 'unavailable' ? SN.unavailable : status
  const chip = state.kind === 'active' ? (
    <span className="skill-node__chips">
      <span className="skill-node__dot" aria-hidden="true" />
      <span className="skill-node__badge">{SN.version(state.version)}</span>
      {versionChanged(d.seenVersion, state.version) && d.seenVersion && (
        <Button type="button" size="xs" variant="secondary" className="skill-node__badge skill-node__badge--updated nodrag" aria-label={SN.updatedHint} onClick={() => rf.updateNodeData(id, { seenVersion: state.version })}>
          {SN.updated(d.seenVersion, state.version)}
        </Button>
      )}
    </span>
  ) : warn ? (
    <span className="skill-node__badge skill-node__badge--off">
      <span className={`codicon ${status === 'disabled' ? 'codicon-circle-slash' : 'codicon-warning'}`} aria-hidden="true" />
      {statusWord}
    </span>
  ) : null

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={220} minHeight={EXPANDED_SIZE.height} color={swatch} />
      <div role="group" aria-label={SN.nodeAria(title, hostNames ? hostNames.split('\n') : [], statusWord)}
        className={collapsed ? 'skill-shape' : `${termNodeClass({ selected: !!selected })} skill-card${warn ? ' skill-node--unavailable' : ''}`} style={{ '--node-swatch': swatch } as CSSProperties}>
        {collapsed ? (
          <SkillToken title={title} slug={d.skill} status={status} version={state.kind === 'active' ? state.version : undefined}
            attached={!!hostNames} statusWord={statusWord} onExpand={toggleCollapse} onRemove={remove}
            updated={state.kind === 'active' && !!d.seenVersion && versionChanged(d.seenVersion, state.version)
              ? { text: SN.updated(d.seenVersion, state.version), dismiss: () => rf.updateNodeData(id, { seenVersion: state.version }) } : undefined} />
        ) : (<>
        <SkillGlyph className="skill-card__avatar" />
        <NodeChrome
          title={title} name={d.name}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          statusChip={chip}
          comments={comments}
          onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          closeLabel={SN.removeAria}
          onClose={remove}
        />
          <div className="node-body skill-node__body">
            {d.skill && <code className="skill-node__slug">{d.skill}</code>}
            {state.kind === 'loading' && <p role="status">{SN.loading}</p>}
            {state.kind === 'error' && <p role="alert">{SN.loadFailed} <Button type="button" size="xs" variant="secondary" className="nodrag" onClick={library.reload}>{SN.retry}</Button></p>}
            {warn && (
              <p className="skill-node__why">
                {state.kind === 'disabled' ? SN.unavailableDisabled : SN.unavailableMissing}
                <Button type="button" size="xs" variant="secondary" className="nodrag skill-node__remove" onClick={remove}>{SN.remove}</Button>
              </p>
            )}
            {state.kind === 'off' && <p>{SN.unavailableOff}</p>}
            {state.kind === 'active' && (
              <IconTooltip label={state.description || SN.noDescription} side="bottom">
                <p className="skill-node__desc" tabIndex={0}>{state.description || SN.noDescription}</p>
              </IconTooltip>
            )}
          </div>
        </>)}
      </div>
      {/* Typed `skill` output on top: the cable runs up into an agent's Skills port (SkillEdge). */}
      <Handle id={SKILL_OUT} type="source" position={Position.Top} className="bridge-handle skill-handle" aria-label={SN.skillOutAria} />
      <span className="skill-port-label skill-port-label--top" aria-hidden="true">{SN.skillPort}</span>
    </>
  )
}

export default memo(SkillNode)
