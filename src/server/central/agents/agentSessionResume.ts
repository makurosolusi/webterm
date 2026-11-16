// Brings a dead agent PTY back from its saved Claude conversation instead of a clean respawn, and nudges a
// live idle agent to carry on. A refusal is a typed value and has NO side effect (the caller then falls back
// to a clean respawn); only `ok:true` has launched a process.
//
// Safety: the relaunch goes through the same host path as the first spawn (`AgentHost.resumePty` ->
// `agent.spawn` -> `sessions.open` -> `launchLine`), so depth/caps/lineage, the per-node token header file
// (rewritten at every open), `--settings`/`--mcp-config`/plugin flags (the CLI does not restore them on
// resume) and the permission mode are rebuilt by the one builder, never copied. The cwd is the agent's own
// worktree allocation, never caller input. No permission bypass flag exists on this path.
//
// Double effects: a tool call that was running when the process died is NOT re-run by the CLI and may have
// left a half-done effect; background shells/subagents died with the process. `repromptContinue` and the
// CLI's own continue prompt both tell the agent to check `git status` before repeating a step.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeSessionId } from '../../../shared/workspace'
import { createLogger } from '../../logs'
import { isInside } from '../../transcriptPath'
import { claudeProjectsRoot } from '../../transcriptPresence'
import type { ToolResult } from '../tools/toolTypes'
import { agentSessionId } from './agentCanvas'
import { agentNodeId, type AgentExecutor, type AgentHost } from './agentExecutor'
import type { AgentStore } from './agentStore'

const log = createLogger('central.agents')

/** A cut-off turn older than this is not continued: its context is stale (CLI `..._MAX_AGE_MS`). */
export const RESUME_MAX_AGE_MS = 60 * 60 * 1000
/** Sent to a live idle agent; wording asks for a state check first because a cut tool call may be half done. */
export const CONTINUE_PROMPT = 'Continue from where you left off. First check `git status` and the current state before repeating any step; do not redo completed work.'

export type ResumeRefusal = 'transcript_missing' | 'too_old' | 'cwd_missing' | 'no_session_id' | 'already_live' | 'launch_failed'
export type ResumeResult =
  | { ok: true; agentId: string; nodeId: string; sessionId: string; cwd: string }
  | { ok: false; code: ResumeRefusal; message: string }

/** Modification time of the saved transcript, or null when absent/unsafe. */
export type TranscriptProbe = (sessionId: string) => number | null

/**
 * mtime of `<root>/<project>/<sessionId>.jsonl`; null unless it is a regular file reached without any symlink
 * (project dir and file are lstat'ed) whose real path is still under the real root.
 */
export function transcriptMtime(sessionId: string, root: string = claudeProjectsRoot()): number | null {
  if (!isSafeSessionId(sessionId, true)) return null
  try {
    const realRoot = realpathSync(root)
    for (const dir of readdirSync(root)) {
      const dirPath = join(root, dir)
      if (!lstatSync(dirPath).isDirectory()) continue
      const file = join(dirPath, `${sessionId}.jsonl`)
      if (!existsSync(file)) continue
      if (!lstatSync(file).isFile() || !isInside(realRoot, realpathSync(file))) return null
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const st = fstatSync(fd)
        return st.isFile() ? st.mtimeMs : null
      } finally {
        closeSync(fd)
      }
    }
    return null
  } catch {
    // Unreadable root or a vanished file = no usable transcript; the caller refuses and falls back to a clean respawn.
    return null
  }
}

export interface ResumeDeps {
  store: Pick<AgentStore, 'get'>
  host: Pick<AgentHost, 'hasSession' | 'resumePty' | 'worktreeOf'>
  now(): number
  /** Default: `transcriptMtime` under the real Claude projects root. */
  transcript?: TranscriptProbe
  /** Default: a real directory on disk. */
  dirExists?(path: string): boolean
}

const refuse = (code: ResumeRefusal, message: string): ResumeResult => ({ ok: false, code, message })
const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** Relaunches `agentId`'s dead PTY with `--resume <session-id>` in its own worktree. */
export async function resumeAgent(deps: ResumeDeps, agentId: string, opts: { maxAgeMs?: number } = {}): Promise<ResumeResult> {
  const maxAge = opts.maxAgeMs ?? RESUME_MAX_AGE_MS
  const agent = deps.store.get(agentId)
  const sessionId = agent && agent.runner === 'pty' ? agentSessionId(agent) : undefined
  if (!agent || !sessionId || !deps.host.resumePty) return refuse('no_session_id', `agent ${agentId}: no resumable session (unknown agent, not a PTY claude agent, or host cannot resume)`)
  const nodeId = agentNodeId(agent.id)
  if (deps.host.hasSession(nodeId)) return refuse('already_live', `agent ${agentId}: its session is still running`)
  const cwd = deps.host.worktreeOf?.(agent) ?? null
  if (!cwd || !(deps.dirExists ?? isDir)(cwd)) return refuse('cwd_missing', `agent ${agentId}: its worktree is gone`)
  const mtime = (deps.transcript ?? ((id) => transcriptMtime(id)))(sessionId)
  if (mtime === null) return refuse('transcript_missing', `agent ${agentId}: no saved conversation for its session`)
  if (deps.now() - mtime > maxAge) return refuse('too_old', `agent ${agentId}: its conversation is older than ${Math.round(maxAge / 60_000)} min`)
  try {
    await deps.host.resumePty(agent, cwd, nodeId, maxAge)
    return { ok: true, agentId, nodeId, sessionId, cwd }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    log.warn('agent.resume_launch_failed', 'resume launch failed', { agentId, cause: cause.slice(0, 200) })
    return refuse('launch_failed', `agent ${agentId}: resume launch failed: ${cause.slice(0, 200)}`)
  }
}

/** Sends the continue prompt to a live agent sitting at its idle prompt; refused (reasoned) when dead or working. */
export function repromptContinue(deps: { store: Pick<AgentStore, 'get'>; executor: Pick<AgentExecutor, 'prompt'> }, agentId: string): Promise<ToolResult> {
  const agent = deps.store.get(agentId)
  if (!agent) return Promise.resolve({ ok: false, code: 'agent_not_found' })
  return deps.executor.prompt(agent, CONTINUE_PROMPT, 'followup')
}
