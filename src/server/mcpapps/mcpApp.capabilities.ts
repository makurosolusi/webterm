// `app.open` capability (MCP tool `app_open`): show an MCP Apps `ui://` view as an App node on the canvas.
// Its HTTP binding is the control route the auth gate opens to node tokens (mcpApp.route.ts).
import { defineCapability, type CapabilitySpec } from '../capability/capability.define'
import { obj, S } from '../capability/capability.schema'

export const APP_OPEN_CAPABILITY = 'app.open'
const PUBLISH_PATH = '/api/control/mcpapps' // = MCP_APPS_PUBLISH_PATH; not imported to keep this file dependency-free

export const MCP_APP_CAPABILITIES: readonly CapabilitySpec[] = [
  defineCapability({
    name: APP_OPEN_CAPABILITY,
    summary: 'Show an MCP Apps ui:// view (text/html;profile=mcp-app) as a sandboxed App node next to this node.',
    tier: 'R1', scope: 'node', projections: ['control-http'], route: { method: 'POST', path: PUBLISH_PATH },
    input: obj({
      uri: S.str(2048, { description: 'The ui:// URI from the tool _meta.ui.resourceUri.' }),
      html: S.str(undefined, { description: 'The view HTML (the text of resources/read on that URI). Give uri+html, or resource.' }),
      resource: S.anyObj('The resources/read result or its content item, as returned by the MCP server (keeps _meta.ui csp/permissions).'),
      toolInput: S.anyObj('Arguments of the tool call the view belongs to.'),
      toolResult: S.anyObj('The CallToolResult of that call.'),
    }),
    output: obj({ appId: S.str() }),
  }),
]
