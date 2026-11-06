// Claude Agent SDK options for one agent chat node (PLAN/AGENT-CHAT.md D2, D3.2, D9). Mirrors what the
// terminal agent launch carries (hooks.ts `buildClaudeFlags`): the node's `--settings` file (status
// hooks + sandbox protection), house rules via `--append-system-prompt-file`, the webterm explore
// plugin and the webterm MCP server via `--mcp-config` file. Files, not inline JSON, for the same
// reason as the terminal: launch wrappers (envman) scan argv and misread `:` (writeClaudeSettings).
// The process starts through the node's launch profile argv (spawn hook), never the bundled binary.
import { spawn as nodeSpawn } from 'node:child_process'
import {
  query, type CanUseTool, type Options, type PermissionMode, type Query, type SDKUserMessage, type SpawnOptions, type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentPermissionMode } from '../../shared/workspace'
import { missingProfileNotice, resolveClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import { writeClaudeSettings, writeHouseRules } from '../hooksSettings'
import { writeClaudeMcpConfig } from '../mcp/mcp.launch'
import { writeExplorePlugin } from '../subagents/exploreAgent'
import { agentChatEnv } from './agentChat.env'

/** Same layers the terminal agent loads: CLAUDE.md, skills, hooks, permissions. */
export const AGENT_CHAT_SETTING_SOURCES: NonNullable<Options['settingSources']> = ['user', 'project', 'local']
/** Fallback executable name when a profile has no claude token. */
const DEFAULT_CLAUDE_BIN = 'claude'
/** Chars of child stderr kept in memory for an error notice (never logged). */
export const AGENT_CHAT_STDERR_TAIL_MAX = 4_000

export type SpawnImpl = (command: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; stdio: 'pipe'; signal: AbortSignal }) => SpawnedProcess

/** webterm mode -> SDK mode: `manual` is the CLI's own `default`, every other mode is identical. */
export function agentChatPermissionMode(m: AgentPermissionMode): PermissionMode {
  return m === 'manual' ? 'default' : m
}

export interface AgentChatOptionsInput {
  nodeId: string
  port: number
  cwd: string
  profileId?: string
  mode: AgentPermissionMode
  resume?: string
  canUseTool: CanUseTool
  abort: AbortController
  parentEnv?: NodeJS.ProcessEnv
  /** Child stderr chunks (keep a bounded tail, never log: prompts and output can be in it). */
  stderr?: (chunk: string) => void
  /** Process spawner behind the SDK hook; tests inject a recorder. */
  spawn?: SpawnImpl
}

/** SDK options for one `query()`; `notice` is set when the node's launch profile no longer exists. */
export function buildAgentChatOptions(i: AgentChatOptionsInput): { options: Options; notice?: string } {
  const launch = resolveClaudeLaunch(i.profileId)
  const argv = launch.argv
  const spawnImpl = i.spawn ?? (nodeSpawn as unknown as SpawnImpl) // ChildProcess satisfies SpawnedProcess (sdk.d.ts)
  const mode = agentChatPermissionMode(i.mode)
  const options: Options = {
    cwd: i.cwd,
    env: agentChatEnv({ nodeId: i.nodeId, port: i.port, parentEnv: i.parentEnv }),
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: AGENT_CHAT_SETTING_SOURCES,
    includePartialMessages: true,
    ...(i.resume ? { resume: i.resume } : {}),
    canUseTool: i.canUseTool,
    abortController: i.abort,
    settings: writeClaudeSettings(i.nodeId, i.port),
    plugins: [{ type: 'local', path: writeExplorePlugin() }],
    extraArgs: { 'append-system-prompt-file': writeHouseRules(), 'mcp-config': writeClaudeMcpConfig(i.nodeId, i.port) },
    // Required next to the hook: the SDK resolves its bundled binary before calling the hook (S0 gate 3).
    pathToClaudeCodeExecutable: launch.bin || DEFAULT_CLAUDE_BIN,
    // `o.command` (the bundled binary) is ignored: the profile argv runs, SDK args appended. `o.env` only,
    // since the SDK already applied `options.env`; merging process.env back would reintroduce CLAUDECODE.
    spawnClaudeCodeProcess: (o: SpawnOptions) =>
      spawnImpl(argv[0] as string, [...argv.slice(1), ...o.args], { cwd: o.cwd, env: o.env, stdio: 'pipe', signal: o.signal }),
    stderr: (chunk: string) => i.stderr?.(chunk),
  }
  return { options, ...(launch.missingId ? { notice: missingProfileNotice(launch.profile.name).trim() } : {}) }
}

/** Bounded in-memory tail of child stderr. */
export function createStderrTail(max = AGENT_CHAT_STDERR_TAIL_MAX): { push(chunk: string): void; text(): string } {
  let tail = ''
  return {
    push(chunk) { tail = (tail + chunk).slice(-max) },
    text: () => tail.trim(),
  }
}

/** What a session hands its opener on every (re)open. */
export interface AgentChatOpenInput {
  prompt: AsyncIterable<SDKUserMessage>
  /** Mode picked in this session (setMode); absent = the node's configured mode. */
  mode?: AgentPermissionMode
  notice(text: string): void
  stderr(chunk: string): void
}

export type AgentChatOpen = (resumeId: string | undefined, canUseTool: CanUseTool, abort: AbortController, input: AgentChatOpenInput) => Query

/** Production opener: SDK `query()` in streaming-input mode, options rebuilt from the profile on every open. */
export function agentChatQueryOpener(cfg: { nodeId: string; port: number; cwd: string; profileId?: string; mode: AgentPermissionMode }): AgentChatOpen {
  return (resumeId, canUseTool, abort, input) => {
    const { options, notice } = buildAgentChatOptions({ ...cfg, mode: input.mode ?? cfg.mode, resume: resumeId, canUseTool, abort, stderr: input.stderr })
    if (notice) input.notice(notice)
    return query({ prompt: input.prompt, options })
  }
}
