import { memo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { randomId } from './randomId'
import { AGENT_CHAT_TITLE } from './agentChat.add'
import { agentConfig, FALLBACK_AGENT_COLOR } from '../shared/workspace'
import type { Comment } from '../shared/workspace'

const COLLAPSED_H = 40
const DEFAULT_H = 400

/** Canvas shell of an Agent Chat node: chrome, cable handles and resizer around the chat body. */
function AgentChatNode({ id, data, selected, height }: NodeProps) {
  const d = data as { color?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const rf = useReactFlow()
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? agentConfig('claude')?.color ?? FALLBACK_AGENT_COLOR
  const comments = d.comments ?? []
  const [maximized, setMaximized] = useState(false)
  const expandedH = useRef(height ?? DEFAULT_H)

  const toggleCollapse = () => {
    if (!collapsed) { expandedH.current = height ?? DEFAULT_H; rf.updateNode(id, { height: COLLAPSED_H }) }
    else rf.updateNode(id, { height: expandedH.current })
    rf.updateNodeData(id, { collapsed: !collapsed })
  }

  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={280} minHeight={200} color={swatch} />
      <div className={termNodeClass({ selected: !!selected, collapsed })} style={{ '--node-swatch': swatch } as CSSProperties}>
        <NodeChrome
          title={d.title || AGENT_CHAT_TITLE}
          icon="comment-discussion"
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments}
          onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          // No refresh or search in the chat shell yet; the buttons stay because NodeToolbar is shared.
          onRefresh={() => undefined}
          searchOpen={false} onToggleSearch={() => undefined}
          maximized={maximized}
          onToggleMaximize={() => { rf.fitView({ nodes: [{ id }], padding: 0.08, duration: 200 }); setMaximized((m) => !m) }}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        <div className="node-body flex items-center justify-center text-sm opacity-70">
          {/* Chat body is mounted by AgentChatView (PLAN/AGENT-CHAT.md W2). */}
          Agent chat
        </div>
        {/* Same cable handles as AgentNode: `agentId: 'claude'` makes it a context-link end (`canLink`). */}
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in" type="target" position={Position.Left} className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(AgentChatNode)
