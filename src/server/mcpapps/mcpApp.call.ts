// `tools/call` from an MCP Apps view, proxied ONLY through webterm's MCP tool path (mcp.tools.ts
// `callTool`): schema check, secret scrubbing, the policy decision and the `mcp.call` audit all apply.
// The principal is the App node itself (`node:<appId>`), never the agent that published it: the view
// is third-party HTML, so it starts from the builtin deny-all for nodes plus open R0 reads, and gets
// more only from a rule the user writes for that node.
import { callTool, type McpDeps, type McpReceipt } from '../mcp/mcp.tools'
import type { McpApp } from './mcpApp.store'

/** MCP `CallToolResult` (what the view's `tools/call` resolves with), same shape as mcp.protocol.ts. */
export interface AppCallResult {
  content: { type: 'text'; text: string }[]
  structuredContent: McpReceipt
  isError: boolean
}

export async function callAppTool(deps: McpDeps, app: Pick<McpApp, 'id'>, name: string, args: Record<string, unknown>): Promise<AppCallResult> {
  // No token: the view holds none, and the only executor that forwards one (browser.*) must refuse it.
  const receipt = await callTool(deps, app.id, '', name, args)
  return { content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt, isError: receipt.outcome !== 'ok' }
}
