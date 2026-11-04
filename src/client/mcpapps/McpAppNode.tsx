// App node: an MCP Apps view (`ui://` resource, SEP-1865) that an agent published from its own MCP
// session. The node id IS the server app id (mcpApp.store.ts). The view runs in a sandboxed srcdoc
// frame (opaque origin, resource CSP as its first bytes) and talks to webterm only over the
// postMessage bridge (mcpApp.bridge.ts); its tools/call goes through webterm policy as `node:<this id>`.
import { memo, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import { ToolbarButton, ToolbarContainer } from '@/vscode/register'
import { callAppTool, fetchAppView, type AppView } from './mcpApp.api'
import { APP_SANDBOX, allowAttribute, createAppBridge } from './mcpApp.bridge'

export const APP_TEXT = {
  loading: 'Loading app…',
  gone: 'This app is no longer available. Apps live until webterm restarts; ask the agent to open it again.',
  frameTitle: 'MCP App view',
}

const theme = (): 'light' | 'dark' => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')

function McpAppNode({ id, data, selected }: NodeProps) {
  const rf = useReactFlow()
  const swatch = (data as { color?: string }).color ?? '#3794ff'
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

  useEffect(() => {
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
  return (
    <>
      <NodeResizer isVisible={!!selected} minWidth={280} minHeight={200} color={swatch} />
      <div className={`term-node mcp-app-node${selected ? ' term-node--selected' : ''}`} style={{ '--node-swatch': swatch, display: 'flex', flexDirection: 'column' } as CSSProperties}>
        <div className="node-header">
          <span className="node-title" title={view ? `${view.uri}\nCSP: ${view.csp}` : undefined}>
            <span className="codicon codicon-window" aria-hidden="true" />
            {view?.uri ?? 'App'}
          </span>
          <span style={{ flex: 1 }} />
          <ToolbarContainer className="nodrag">
            <ToolbarButton label="Close" title="Close" onClick={() => void rf.deleteElements({ nodes: [{ id }] })}><span className="codicon codicon-close" aria-hidden="true" /></ToolbarButton>
          </ToolbarContainer>
        </div>
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
