// HTTP paths of the MCP backend. Under `/api/control/` on purpose: that family is the one the auth
// gate already opens to node tokens (auth.ts `isNodeTokenPath`), so no new token path is created.
export const MCP_PREFIX = '/api/control/mcp'
export const MCP_TOOLS_PATH = `${MCP_PREFIX}/tools`
export const MCP_CALL_PATH = `${MCP_PREFIX}/call`
/** Server name the CLIs register us under (tool names become `mcp__webterm__<tool>` in Claude Code). */
export const MCP_SERVER_NAME = 'webterm'
/** `mintedBy` prefix of the capability tokens the Central runtime mints for its MCP child (mcp.central.ts). */
export const CENTRAL_MCP_MINTER = 'central-mcp:'
/** Receipt evidence `approvalStatus` meaning "a card exists and nobody decided yet" (mcp.central.ts; main.ts polls on it). */
export const APPROVAL_PENDING = 'pending'
