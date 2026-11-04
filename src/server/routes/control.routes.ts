// Agent-facing control: hook callback, `webterm` CLI tools, MCP backend, headless control plane,
// read-only context-link.
import { agentStatusRoute } from '../agentStatusApi'
import { toolsRoute } from '../capability/capability.http'
import { handleMcpHttp } from '../mcp/mcp.route'
import { handleControlHttp } from '../control/mount'
import { contextLinkRoute } from '../contextLinkApi'
import type { ApiRoute } from './route.core'

export const controlRoutes: ApiRoute[] = [
  // Hook callback from a claude session (body is the hook stdin JSON).
  { name: 'agent-status', handle: (c) => agentStatusRoute(c.req, c.res, c.url) },
  // /api/tools: registry for the `webterm` CLI (capability.http.ts)
  { name: 'tools', handle: (c) => toolsRoute(c.req, c.res, c.url, { dispatch: c.dispatch }) },
  // /api/control/mcp/*: backend of `webterm mcp` (mcp.route.ts); before the control family it nests in
  { name: 'mcp', handle: (c) => handleMcpHttp(c.req, c.res, c.url, () => c.readBody()) },
  // Headless control plane (/api/control/*): false = not this family, keep falling through.
  { name: 'control', handle: (c) => handleControlHttp(c.req, c.res, c.url, () => c.readBody()) },
  // Read-only context-link: a linked node reads a bridged peer's transcript/terminal.
  { name: 'context-link', handle: (c) => contextLinkRoute(c.req, c.res, c.url) },
]
