// Per-turn MCP wiring for the Claude Central runtime (PLAN F2-c, K7): Claude Code reaches webterm's
// tools natively through `webterm mcp` (src/server/mcp/main.ts) instead of text proposals.
// Each turn gets a fresh capability token minted for `central-mcp:<conversationId>` (mcp.central.ts),
// written to a 0600 header file the MCP child reads; argv and env never carry it, and the child env
// filter (claudeOptions `claudeChildEnv`) stays as is. Files and token die with the turn.
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAPABILITY_HEADER } from '../../auth'
import { MCP_MAIN } from '../../mcp/mcp.launch'
import { CENTRAL_MCP_MINTER, MCP_SERVER_NAME } from '../../mcp/mcp.paths'
import { parsePort } from '../../serverConfig'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
/** The token outlives the turn wall a little so the last poll is not refused mid-call. */
const TOKEN_GRACE_MS = 30_000
/** Capability store ceiling (control/capabilities MAX_TTL_MS). */
const MAX_TOKEN_TTL_MS = 60 * 60_000
/** Longest an approval card may hold one tool call inside a turn before the receipt says "still pending". */
export const DEFAULT_APPROVAL_WAIT_MS = 60_000
/**
 * Identity-only capability: a resource no workspace has and an agent id nobody presents, so the token
 * opens nothing in the control API; mcp.route reads only its `mintedBy`.
 */
export const IDENTITY_RESOURCE = 'workspace:central-mcp-identity'
const IDENTITY_AGENT = 'central-mcp-identity'

export interface MintedToken { token: string; revoke(): void }
export type MintCentralToken = (conversationId: string, ttlMs: number) => Promise<MintedToken> | MintedToken
export interface McpTurn { conversationId: string; turnId: string; wallMs: number }
export interface OpenedMcp { configPath: string; close(): void }

/** What the runtime needs per turn; tests inject their own. */
export interface CentralMcpLink { open(turn: McpTurn): Promise<OpenedMcp> }

/** Process capability store (loaded lazily: control/mount pulls in the control API graph). */
export const processMint: MintCentralToken = async (conversationId, ttlMs) => {
  const { capabilityStore } = await import('../../control/mount')
  const token = capabilityStore.mint({ verb: 'node.read', resource: IDENTITY_RESOURCE, qualifier: { agentIds: [IDENTITY_AGENT] }, ttlMs, mintedBy: `${CENTRAL_MCP_MINTER}${conversationId}` })
  return { token, revoke: () => { capabilityStore.revoke(token) } }
}

export interface LinkOptions {
  /** Folder for the per-turn config/header files (created 0700). */
  dir: string
  port?: number
  mint?: MintCentralToken
  approvalWaitMs?: number
  /** Executable + leading args that start the MCP server; defaults to this bun + main.ts. */
  command?: { command: string; args: string[] }
}

/** Writes `--mcp-config` + header file for one turn; `close()` revokes the token and removes both. */
export function createCentralMcpLink(o: LinkOptions): CentralMcpLink {
  return {
    async open(turn) {
      mkdirSync(o.dir, { recursive: true, mode: DIR_MODE })
      chmodSync(o.dir, DIR_MODE)
      const ttl = Math.min(MAX_TOKEN_TTL_MS, turn.wallMs + TOKEN_GRACE_MS)
      const minted = await (o.mint ?? processMint)(turn.conversationId, ttl)
      // Hashed name: the turn id is server-made, but a file name never needs to carry it raw.
      const name = createHash('sha256').update(turn.turnId).digest('hex').slice(0, 16)
      const headers = join(o.dir, `${name}.headers`)
      const configPath = join(o.dir, `${name}.mcp.json`)
      const close = (): void => {
        minted.revoke()
        rmSync(headers, { force: true })
        rmSync(configPath, { force: true })
      }
      try {
        writeFileSync(headers, `${CAPABILITY_HEADER}: ${minted.token}\n`, { mode: FILE_MODE })
        const base = o.command ?? { command: process.versions.bun ? process.execPath : 'bun', args: [MCP_MAIN] }
        const wait = Math.max(0, Math.min(o.approvalWaitMs ?? DEFAULT_APPROVAL_WAIT_MS, turn.wallMs))
        const args = [...base.args, '--headers', headers, '--port', String(o.port ?? parsePort(process.env.PORT)), '--approval-wait-ms', String(wait)]
        writeFileSync(configPath, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: base.command, args } } }), { mode: FILE_MODE })
      } catch (err) {
        close()
        throw new Error(`central mcp: could not write turn files for ${turn.turnId}: ${err instanceof Error ? err.message : String(err)}`)
      }
      return { configPath, close }
    },
  }
}
