// Per-CLI auto-configuration of `webterm mcp` at spawn (JetBrains-style auto-configure), touching only
// webterm-owned files and per-process flags/env, never the user's global CLI config:
//   claude   --mcp-config <file>                 (code.claude.com/docs/en/mcp; `claude --help`)
//   codex    -c mcp_servers.webterm.command/args (Codex MCP docs: [mcp_servers.<name>] command/args;
//                                                 `codex --help`: -c overrides any config.toml key, TOML value)
//   opencode OPENCODE_CONFIG_CONTENT             (opencode.ai/docs/config: inline config, merged last;
//                                                 opencode.ai/docs/mcp-servers: type local + command array)
//   gemini   GEMINI_CLI_SYSTEM_DEFAULTS_PATH     (geminicli.com docs: system-defaults layer, lowest precedence,
//                                                 mcpServers objects merged; var present in gemini 0.60.0 bundle)
// The server command carries the PATH of the node's header file and the port, never the token, and no
// `:` anywhere in argv (launch wrappers such as envman read `slug:path` in argv; see codexInstructionsFlag).
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { capabilityAgentId, type AgentId } from '../../shared/workspace'
import { claudeHeadersPath, claudeSettingsPath, ensureNodeSettingsDir } from '../hooksPaths'
import { shq } from '../hooksQuote'
import { tomlString } from '../webtermAwareness'
import { MCP_SERVER_NAME } from './mcp.paths'

/** Absolute path of the stdio entry point. */
export const MCP_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'
export const GEMINI_DEFAULTS_ENV = 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH'

/** How a CLI starts the MCP server for `nodeId`: the running bun (the server runs under bun) + main.ts. */
export function mcpServerCommand(nodeId: string, port: number): { command: string; args: string[] } {
  const bun = process.versions.bun ? process.execPath : 'bun'
  return { command: bun, args: [MCP_MAIN, '--headers', claudeHeadersPath(nodeId), '--port', String(port)] }
}

/** Sibling of the node's `--settings` file (same hashed name, so no traversal from the node id). */
export const mcpConfigPath = (nodeId: string, kind: 'claude' | 'gemini'): string =>
  claudeSettingsPath(nodeId).replace(/\.json$/, `.${kind === 'claude' ? 'mcp' : 'gemini'}.json`)

export type WriteFile = (path: string, text: string) => void
const writeOwnFile: WriteFile = (path, text) => {
  ensureNodeSettingsDir()
  writeFileSync(path, text, { mode: 0o600 })
}

/** Claude Code `--mcp-config` file for this node; returns its path. */
export function writeClaudeMcpConfig(nodeId: string, port: number, write: WriteFile = writeOwnFile): string {
  const path = mcpConfigPath(nodeId, 'claude')
  write(path, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', ...mcpServerCommand(nodeId, port) } } }))
  return path
}

/** Codex root options (before any subcommand such as `resume`). */
export function codexMcpFlags(nodeId: string, port: number): string {
  const { command, args } = mcpServerCommand(nodeId, port)
  const key = `mcp_servers.${MCP_SERVER_NAME}`
  return [
    `-c ${shq(`${key}.command=${tomlString(command)}`)}`,
    `-c ${shq(`${key}.args=[${args.map(tomlString).join(',')}]`)}`,
  ].join(' ')
}

/** Env that points opencode / gemini at the server; empty for every other agent. */
export function mcpEnv(agentId: AgentId, nodeId: string, port: number, write: WriteFile = writeOwnFile): Record<string, string> {
  const { command, args } = mcpServerCommand(nodeId, port)
  switch (capabilityAgentId(agentId)) {
    case 'opencode':
      return { [OPENCODE_CONFIG_ENV]: JSON.stringify({ mcp: { [MCP_SERVER_NAME]: { type: 'local', command: [command, ...args], enabled: true } } }) }
    case 'gemini': {
      const path = mcpConfigPath(nodeId, 'gemini')
      write(path, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command, args } } }))
      return { [GEMINI_DEFAULTS_ENV]: path }
    }
    default: return {}
  }
}
