// Claude Agent SDK options for one agent chat node (PLAN/AGENT-CHAT.md D2, D3.2, D9). Mirrors what the
// terminal agent launch carries (hooks.ts `buildClaudeFlags`): the node's `--settings` file (status
// hooks + sandbox protection), house rules via `--append-system-prompt-file`, the webterm explore
// plugin and the webterm MCP server via `--mcp-config` file. Files, not inline JSON, for the same
// reason as the terminal: launch wrappers (envman) scan argv and misread `:` (writeClaudeSettings).
// The process starts through the node's launch profile argv (spawn hook), never the bundled binary.
import { mkdirSync } from 'node:fs'
import { query, type CanUseTool, type Options, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatConfig } from '../../shared/agentChat.wire'
import type { AgentPermissionMode } from '../../shared/workspace'
import { AGENT_CHAT_DEFAULT_CONFIG, configOptions } from './agentChat.controls'
import { agentChatFableTarget, agentChatLadderPick, withLadderDefault } from './agentChat.ladder'
import { missingProfileNotice, nodeClaudeLaunch } from '../claudeLauncher/claudeLauncher'
import { claudeSdkSpawn, type SpawnImpl } from '../claudeLauncher/claudeSdkSpawn'
import { writeClaudeSettings, writeHouseRules } from '../hooksSettings'
import { writeClaudeMcpConfig } from '../mcp/mcp.launch'
import { writeExplorePlugin } from '../subagents/exploreAgent'
import { agentChatUploadsDir } from './agentChat.attach'
import { agentChatEnv } from './agentChat.env'
import { agentChatLockFor } from './agentChat.toolLock'

/** Same layers the terminal agent loads: CLAUDE.md, skills, hooks, permissions. */
export const AGENT_CHAT_SETTING_SOURCES: NonNullable<Options['settingSources']> = ['user', 'project', 'local']
/** Chars of child stderr kept in memory for an error notice (never logged). */
export const AGENT_CHAT_STDERR_TAIL_MAX = 4_000

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
  /** Model / effort / thinking picked in the node; an absent model/effort comes from the model ladder. */
  config?: AgentChatConfig
  /** Workspace of the node: its `projectModels` override steers the ladder default. */
  workspaceId?: string
  canUseTool: CanUseTool
  abort: AbortController
  parentEnv?: NodeJS.ProcessEnv
  /** Child stderr chunks (keep a bounded tail, never log: prompts and output can be in it). */
  stderr?: (chunk: string) => void
  /** Root of staged uploads (default `<data dir>/agent-chat-uploads`); tests pass a temp dir. */
  uploadsRoot?: string
  /** Process spawner behind the SDK hook; tests inject a recorder. */
  spawn?: SpawnImpl
  /** The node's stored preset; a known one locks the tools server-side (agentChat.toolLock.ts). */
  preset?: string
}

/** SDK options for one `query()`; `notice` is set when the node's launch profile no longer exists. */
export function buildAgentChatOptions(i: AgentChatOptionsInput): { options: Options; notice?: string } {
  // Same rule as a terminal node with this claudeProfileId (stored default follows command mode).
  const launch = nodeClaudeLaunch(i.profileId)
  const mode = agentChatPermissionMode(i.mode)
  // Only this node's staged files, never other nodes': created first, the CLI expects an existing dir.
  const uploads = agentChatUploadsDir(i.nodeId, i.uploadsRoot)
  mkdirSync(uploads, { recursive: true, mode: 0o700 })
  const lock = agentChatLockFor(i.preset)
  const options: Options = {
    cwd: i.cwd,
    additionalDirectories: [uploads],
    env: agentChatEnv({ nodeId: i.nodeId, port: i.port, parentEnv: i.parentEnv }),
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: AGENT_CHAT_SETTING_SOURCES,
    includePartialMessages: true,
    ...(i.resume ? { resume: i.resume } : {}),
    ...configOptions(withLadderDefault(i.config ?? AGENT_CHAT_DEFAULT_CONFIG, agentChatLadderPick(i.workspaceId, i.nodeId), agentChatFableTarget(i.nodeId, i.workspaceId))),
    canUseTool: i.canUseTool,
    abortController: i.abort,
    settings: writeClaudeSettings(i.nodeId, i.port),
    plugins: [{ type: 'local', path: writeExplorePlugin() }],
    // Checkpoints for "Rewind to here" (Query.rewindFiles); the docs (agent-sdk/file-checkpointing) require
    // `replay-user-messages` next to it so the CLI acknowledges each user message uuid. Replays map to nothing.
    enableFileCheckpointing: true,
    extraArgs: { 'append-system-prompt-file': writeHouseRules(), 'mcp-config': writeClaudeMcpConfig(i.nodeId, i.port), 'replay-user-messages': null },
    // The profile argv runs (not the bundled binary); the hook also drains stderr into `i.stderr`.
    ...claudeSdkSpawn({ launch, ...(i.spawn ? { spawn: i.spawn } : {}), ...(i.stderr ? { stderr: i.stderr } : {}) }),
  }
  if (lock) {
    // Locked preset: its fields win over the chat mode (a bypass default must not apply), and no
    // bypass flag, plugin, MCP config or uploads dir (no Read tool) is carried.
    Object.assign(options, lock)
    delete options.allowDangerouslySkipPermissions
    delete options.plugins
    delete options.additionalDirectories
    options.extraArgs = { 'append-system-prompt-file': writeHouseRules(), 'disable-slash-commands': null, 'replay-user-messages': null }
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
  /** Model / effort / thinking of this session (setConfig). */
  config?: AgentChatConfig
  notice(text: string): void
  stderr(chunk: string): void
}

export type AgentChatOpen = (resumeId: string | undefined, canUseTool: CanUseTool, abort: AbortController, input: AgentChatOpenInput) => Query

/** Production opener: SDK `query()` in streaming-input mode, options rebuilt from the profile on every open. */
export function agentChatQueryOpener(cfg: { nodeId: string; port: number; cwd: string; profileId?: string; mode: AgentPermissionMode; workspaceId?: string; preset?: string }): AgentChatOpen {
  return (resumeId, canUseTool, abort, input) => {
    const { options, notice } = buildAgentChatOptions({ ...cfg, mode: input.mode ?? cfg.mode, ...(input.config ? { config: input.config } : {}), resume: resumeId, canUseTool, abort, stderr: input.stderr })
    if (notice) input.notice(notice)
    return query({ prompt: input.prompt, options })
  }
}
