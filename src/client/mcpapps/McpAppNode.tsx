// App node: an MCP Apps view (`ui://` resource, SEP-1865) that an agent published from its own MCP
// session. The node id IS the server app id (mcpApp.store.ts). The view runs in a sandboxed srcdoc
// frame (opaque origin, resource CSP as its first bytes) and talks to webterm only over the
// postMessage bridge (mcpApp.bridge.ts); its tools/call goes through webterm policy as `node:<this id>`.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { NodeLayoutResizer, NodeResizeToggle } from '../nodeResize/NodeLayoutResizer'
import { ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { callAppTool, fetchAppView, type AppView } from './mcpApp.api'
import { APP_SANDBOX, allowAttribute, createAppBridge } from './mcpApp.bridge'
import { NodeNameLabel } from '../nodeName.label'
import { useNodeHost } from '../tabLayout.context'
import TabNodeActions from '../tabLayout.nodeActions'

export const APP_TEXT = {
  loading: 'Loading app…',
  gone: 'This app is no longer available. Apps live until webterm restarts; ask the agent to open it again.',
  frameTitle: 'MCP App view',
}

const theme = (): 'light' | 'dark' => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')

function McpAppNode({ id, data, selected }: NodeProps) {
  const rf = useReactFlow()
  const d = data as { color?: string; name?: string }
  const swatch = d.color ?? '#3794ff'
  const [view, setView] = useState<AppView | null>(null)
  const [error, setError] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)

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
      openLink: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
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
      <NodeLayoutResizer minWidth={280} minHeight={200} color={swatch} />
      <div className={`term-node mcp-app-node${selected ? ' term-node--selected' : ''}`} style={{ '--node-swatch': swatch, display: 'flex', flexDirection: 'column' } as CSSProperties}>
        {host.inTab ? <TabNodeActions id={id} visible={host.visible} items={[]} /> : (
        <div className="node-header">
          <span className="node-title" title={view ? `${view.uri}\nCSP: ${view.csp}` : undefined}>
            <span className="codicon codicon-window" aria-hidden="true" />
            <NodeNameLabel name={d.name} label={view?.uri ?? 'App'} />
          </span>
          <span style={{ flex: 1 }} />
          <NodeResizeToggle />
          <ToolbarContainer className="nodrag">
            <ToolbarButton label="Close" title="Close" onClick={() => void rf.deleteElements({ nodes: [{ id }] })}><span className="codicon codicon-close" aria-hidden="true" /></ToolbarButton>
          </ToolbarContainer>
        </div>
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
