import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from './nodeResize/NodeLayoutResizer'
import NodeChrome, { termNodeClass } from './NodeChrome'
import { randomId } from './randomId'
import { AGENT_CHAT_TITLE } from './agentChat.add'
import { agentConfig, FALLBACK_AGENT_COLOR } from '../shared/workspace'
import type { Comment } from '../shared/workspace'
import type { AgentChatData } from '../shared/agentChat.shape'
import type { AgentChatPatch } from './agentChat/agentChatView'
import { LazyPaneFallback } from './lazyPaneFallback'
import { unwatchNode, watchNode } from './unread'
import { ClaudeViewToggle } from './agentChat/claudeViewSwitch'

// The chat body (and its markdown/tool-card tree) loads with the first chat node; the chrome stays eager.
const AgentChatView = lazy(() => import('./agentChat/agentChatView').then((m) => ({ default: m.AgentChatView })))

const COLLAPSED_H = 40
const DEFAULT_H = 400

/** Canvas shell of an Agent Chat node: chrome, cable handles and resizer around the chat body. */
function AgentChatNode({ id, data, selected, height }: NodeProps) {
  const d = data as { color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[] } & Pick<AgentChatData, 'chatSessionId' | 'permissionMode' | 'chatConfig' | 'preset'> & { cwd?: string }
  const rf = useReactFlow()
  const onNodeData = useCallback((patch: AgentChatPatch) => rf.updateNodeData(id, patch), [rf, id])
  const collapsed = d.collapsed ?? false
  const swatch = d.color ?? agentConfig('claude')?.color ?? FALLBACK_AGENT_COLOR
  const comments = d.comments ?? []
  const expandedH = useRef(height ?? DEFAULT_H)
  // Reported by the view (its reducer holds the chat status); per node, gates "Open as terminal".
  const [busy, setBusy] = useState(false)
  // Header slot the view portals its conversation history button into (not a composer control).
  const [headerHost, setHeaderHost] = useState<HTMLSpanElement | null>(null)
  // Selected = watched, as in AgentNode: a turn that ends while you sit here is neither unread nor notified.
  useEffect(() => {
    if (!selected) return
    watchNode(id)
    return () => unwatchNode(id)
  }, [selected, id])

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
          title={d.title || AGENT_CHAT_TITLE} name={d.name}
          icon="comment-discussion"
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments}
          extraHeader={<><span ref={setHeaderHost} className="agent-chat-head-slot nodrag" /><ClaudeViewToggle nodeId={id} view="chat" busy={busy} /></>}
          onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          // No refresh or search in the chat shell yet; the buttons stay because NodeToolbar is shared.
          onRefresh={() => undefined}
          searchOpen={false} onToggleSearch={() => undefined}
          onClose={() => { void rf.deleteElements({ nodes: [{ id }] }) }}
        />
        <div className="node-body">
          <Suspense fallback={<LazyPaneFallback />}>
            <AgentChatView nodeId={id} cwd={d.cwd} chatSessionId={d.chatSessionId} permissionMode={d.permissionMode} chatConfig={d.chatConfig} preset={d.preset} onNodeData={onNodeData} onBusy={setBusy} headerHost={headerHost} />
          </Suspense>
        </div>
        {/* Same cable handles as AgentNode: `agentId: 'claude'` makes it a context-link end (`canLink`). */}
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in" type="target" position={Position.Left} className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(AgentChatNode)
