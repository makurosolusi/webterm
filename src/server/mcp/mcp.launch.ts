// Auto-configuration of `webterm mcp` at spawn (JetBrains-style auto-configure) for Claude Code, through
// `--mcp-config <file>` (code.claude.com/docs/en/mcp), touching only webterm-owned files, never the
// user's global CLI config. The server command carries the PATH of the node's header file and the port,
// never the token, and no `:` anywhere in argv (launch wrappers such as envman read `slug:path` in argv).
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { claudeHeadersPath, claudeSettingsPath, ensureNodeSettingsDir } from '../hooksPaths'
import { MCP_STDIO_COMMAND, type SelfLaunchMode, selfLaunch, selfLaunchMode } from '../selfLaunch'
import { MCP_SERVER_NAME } from './mcp.paths'

/** Absolute path of the stdio entry point (dev only: a compiled binary or bundled host re-enters itself, selfLaunch.ts). */
export const MCP_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

/** Executable + leading args that start the MCP stdio server: `bun main.ts` in dev, `webterm __mcp-stdio` when
 *  compiled, `bun <bundle> __mcp-stdio` in the native app. */
export const mcpLaunchBase = (mode: SelfLaunchMode = selfLaunchMode()): { command: string; args: string[] } =>
  selfLaunch(MCP_STDIO_COMMAND, MCP_MAIN, mode)

/** How a CLI starts the MCP server for `nodeId`. */
export function mcpServerCommand(nodeId: string, port: number): { command: string; args: string[] } {
  const base = mcpLaunchBase()
  return { command: base.command, args: [...base.args, '--headers', claudeHeadersPath(nodeId), '--port', String(port)] }
}

/** Sibling of the node's `--settings` file (same hashed name, so no traversal from the node id). */
export const mcpConfigPath = (nodeId: string): string => claudeSettingsPath(nodeId).replace(/\.json$/, '.mcp.json')

export type WriteFile = (path: string, text: string) => void
const writeOwnFile: WriteFile = (path, text) => {
  ensureNodeSettingsDir()
  writeFileSync(path, text, { mode: 0o600 })
}

/** Claude Code `--mcp-config` file for this node; returns its path. */
export function writeClaudeMcpConfig(nodeId: string, port: number, write: WriteFile = writeOwnFile): string {
  const path = mcpConfigPath(nodeId)
  write(path, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', ...mcpServerCommand(nodeId, port) } } }))
  return path
}
