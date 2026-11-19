// App node: an MCP Apps view (`ui://` resource, SEP-1865) that an agent published from its own MCP
// session. The node id IS the server app id (mcpApp.store.ts). The view runs in a sandboxed srcdoc
// frame (opaque origin, resource CSP as its first bytes) and talks to webterm only over the
// postMessage bridge (mcpApp.bridge.ts); its tools/call goes through webterm policy as `node:<this id>`.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer } from '../nodeResize/NodeLayoutResizer'
import NodeChrome, { termNodeClass } from '../NodeChrome'
import { useNodeCollapse } from '../nodeCollapse'
import { randomId } from '../randomId'
import type { Comment } from '../../shared/workspace'
import { callAppTool, fetchAppView, type AppView } from './mcpApp.api'
import { APP_SANDBOX, allowAttribute, createAppBridge } from './mcpApp.bridge'
import { openLinkInCanvas } from '../canvasLinks'
import { useNodeActions } from '../nodeActions'
import { useNodeHost } from '../tabLayout.context'
import TabNodeActions from '../tabLayout.nodeActions'

export const APP_TEXT = {
  loading: 'Loading app…',
  gone: 'This app is no longer available. Apps live until webterm restarts; ask the agent to open it again.',
  frameTitle: 'MCP App view',
}

const theme = (): 'light' | 'dark' => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')

function McpAppNode({ id, data, selected, height }: NodeProps) {
  const rf = useReactFlow()
  const d = data as { color?: string; name?: string; title?: string; collapsed?: boolean; comments?: Comment[] }
  const swatch = d.color ?? '#3794ff'
  const collapsed = d.collapsed ?? false
  const comments = d.comments ?? []
  const toggleCollapse = useNodeCollapse(id, height, collapsed)
  const [view, setView] = useState<AppView | null>(null)
  const [error, setError] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  // Read at click time: the bridge is built once per view.
  const actions = useRef(useNodeActions())
  actions.current = useNodeActions()

  useEffect(() => {
    let live = true
    fetchAppView(id).then((v) => { if (live) setView(v) }, (e: unknown) => {
      if (live) setError((e as { status?: number }).status === 404 ? APP_TEXT.gone : e instanceof Error ? e.message : String(e))
    })
    return () => { live = false }
  }, [id])

  // Layout effect, not a passive one: it runs in the same commit that inserts the iframe, before the
  // frame can load and post `ui/initialize`. A passive effect is flushed in a later task, so a fast view
  // (or a busy main thread) could send its first message to a page that is not listening yet.
  useLayoutEffect(() => {
    if (!view) return
    const win = () => frame.current?.contentWindow ?? null
    const bridge = createAppBridge({
      // The view has an opaque origin, so '*' is the only target that reaches it; the window itself
      // is the address (a navigated-away frame is a different document and gets nothing it asked for).
      post: (msg) => win()?.postMessage(msg, '*'),
      callTool: (name, args) => callAppTool(id, name, args),
      openLink: (url) => { openLinkInCanvas(url, { openBrowserAt: actions.current.openBrowserAt, anchorNodeId: id }) },
      theme: theme(),
      ...(view.toolInput ? { toolInput: view.toolInput } : {}),
      ...(view.toolResult ? { toolResult: view.toolResult } : {}),
    })
    const onMessage = (e: MessageEvent) => {
      // Only this node's frame: any other window (another App node, the page itself) is ignored.
      if (e.source === null || e.source !== win()) return
      void bridge.handle(e.data)
    }
    window.addEventListener('message', onMessage)
    return () => { bridge.teardown('node closed'); window.removeEventListener('message', onMessage) }
  }, [view, id])

  const allow = view ? allowAttribute(view.permissions) : ''
  // Tab mode: the tab is the header (its × closes the node); the app has no other header actions.
  const host = useNodeHost()
  return (
    <>
      <NodeLayoutResizer collapsed={collapsed} minWidth={280} minHeight={200} color={swatch} />
      <div className={`${termNodeClass({ selected: !!selected, collapsed })} mcp-app-node`} style={{ '--node-swatch': swatch, display: 'flex', flexDirection: 'column' } as CSSProperties}>
        {host.inTab ? <TabNodeActions id={id} visible={host.visible} items={[]} /> : (
        <NodeChrome
          title={d.title || view?.uri || 'App'} name={d.name} icon="window" titleHint={view ? `${view.uri} · CSP: ${view.csp}` : undefined}
          onRename={(t) => rf.updateNodeData(id, { title: t })}
          collapsed={collapsed} onToggleCollapse={toggleCollapse}
          color={swatch} onColor={(c) => rf.updateNodeData(id, { color: c })}
          comments={comments} onAddComment={(text) => rf.updateNodeData(id, { comments: [...comments, { id: randomId(), text, ts: Date.now() }] })}
          closeLabel="Close" onClose={() => void rf.deleteElements({ nodes: [{ id }] })}
        />
        )}
        <div className="node-body nodrag nowheel nokey" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {error ? <p role="alert" style={{ padding: 12, margin: 0, fontSize: 12 }}>{error}</p>
            : !view ? <p role="status" style={{ padding: 12, margin: 0, fontSize: 12 }}>{APP_TEXT.loading}</p>
            : (
              <iframe
                ref={frame}
                title={APP_TEXT.frameTitle}
                sandbox={APP_SANDBOX}
                {...(allow ? { allow } : {})}
                referrerPolicy="no-referrer"
                srcDoc={view.html}
                style={{ flex: 1, border: view.prefersBorder ? '1px solid var(--border)' : 'none', background: 'transparent' }}
              />
            )}
        </div>
        <Handle id="link-out" type="source" position={Position.Right} className="bridge-handle" />
        <Handle id="link-in" type="target" position={Position.Left} className="bridge-handle" />
      </div>
    </>
  )
}

export default memo(McpAppNode)
