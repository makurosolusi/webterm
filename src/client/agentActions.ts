// Pure helpers for an agent node's lifecycle actions: ask the CLI to quit cleanly, then relaunch it
// with its own `--resume` so the conversation comes back. No DOM or transport, so the context menu,
// the restart choreography and the tests all share one rule set.
//
// webterm runs an agent as `shell -l -c "<cmd>"`: when the CLI exits, the shell exits and the PTY
// ends. There is no idle shell to poll or type into, so the relaunch phase is time-based (see
// `EXIT_SETTLE_MS`); `AgentNode` fills in that phase.

import { canResume, capabilityAgentId, isSafeSessionId, type AgentId, type AgentStatus } from '../shared/workspace'

/**
 * How Claude Code is asked to quit, from its documented keys
 * (https://code.claude.com/docs/en/interactive-mode, "General controls"):
 * - `Ctrl+C` interrupts a running operation; with nothing running, the first press clears the
 *   prompt input and a second press exits.
 * - `/exit` is the documented slash command, but typing it would land in a permission dialog or
 *   a half-written draft, so the restart path uses Ctrl+C presses instead.
 * - `Ctrl+D` also exits, but with text in the prompt it deletes a character, so it is not used.
 * Behaviour checked against the CLI on this machine: 2.1.325.
 */
const CLAUDE_EXIT_COMMAND = '/exit'
/** Presses the docs describe: one to clear the draft, one to exit. */
const CLAUDE_CTRL_C_DOCUMENTED = 2
/** One extra press in case the first press only armed the "press again to exit" state. A press after the CLI is gone hits a dead PTY and is harmless. */
const CLAUDE_CTRL_C_MARGIN = 1

interface ExitProfile {
  /** The CLI's own exit slash command; its presence also marks the CLI as safe to ask to quit. */
  command: string
  /** How many Ctrl+C presses reliably quit it, with or without a draft in the prompt. */
  ctrlCPresses: number
}

/**
 * Per-harness exit behaviour. Only harnesses listed here can be restarted in place; unknown CLIs
 * (including non-Claude CLIs run in a terminal) have no safe way to be asked to quit.
 */
const EXIT_PROFILES: Record<string, ExitProfile> = {
  claude: { command: CLAUDE_EXIT_COMMAND, ctrlCPresses: CLAUDE_CTRL_C_DOCUMENTED + CLAUDE_CTRL_C_MARGIN },
}

const CTRL_C = '\x03'

/** Pause between consecutive Ctrl+C presses so the CLI sees separate presses, not one burst. */
export const CTRL_C_GAP_MS = 150

function profileFor(agentId: AgentId | undefined): ExitProfile | null {
  if (!agentId) return null
  return EXIT_PROFILES[capabilityAgentId(agentId)] ?? null
}

/**
 * The exit command of an agent, or null when its CLI cannot be asked to quit. Resolved through the
 * base harness, so a custom agent built on claude quits like claude.
 */
export function exitSequence(agentId: AgentId | undefined): string | null {
  return profileFor(agentId)?.command ?? null
}

export type IneligibleReason = 'working' | 'no-session' | 'not-resumable'

/**
 * Statuses that must be left alone. `blocked` means a permission or question dialog owns the
 * prompt, so quitting would answer that dialog instead of closing the CLI. Both are reported as
 * `'working'`: to the user both mean "busy, try again shortly".
 */
const BUSY_STATES: readonly AgentStatus[] = ['working', 'blocked']

/**
 * The single gate shared by the context menu and the restart choreography.
 *
 * `not-resumable` outranks the other reasons: a CLI that cannot be asked to quit or resumed will
 * never restart, so waiting cannot fix it.
 */
export function restartEligibility(
  agentId: AgentId | undefined,
  state: AgentStatus | undefined,
  sessionId: string | undefined
): { ok: true } | { ok: false; reason: IneligibleReason } {
  if (!agentId || !canResume(agentId) || !exitSequence(agentId)) return { ok: false, reason: 'not-resumable' }
  if (state !== undefined && BUSY_STATES.includes(state)) return { ok: false, reason: 'working' }
  // Without a provider session id there is nothing to resume.
  if (!sessionId || !isSafeSessionId(sessionId)) return { ok: false, reason: 'no-session' }
  return { ok: true }
}

/** User-facing sentence for a refusal: what to wait for or why it cannot work. */
export function ineligibleHint(reason: IneligibleReason): string {
  switch (reason) {
    case 'working':
      return 'This session is busy — restart after the turn (or permission prompt) finishes.'
    case 'no-session':
      return 'Nothing to resume yet — this session has not reported an id.'
    case 'not-resumable':
      return 'This CLI can’t be asked to exit and resume.'
  }
}

/** One write of the exit sequence; `gapAfterMs` is the pause AFTER it, before the next write. */
export interface ExitWrite {
  data: string
  gapAfterMs: number
}

/**
 * The writes that ask an agent to quit, or null when it cannot be asked. Repeated Ctrl+C only: no
 * Escape (a live agent reads it as interrupt), no Ctrl+U or Enter (Ctrl+C already clears the
 * prompt, and no Enter means a draft is never submitted).
 */
export function exitWrites(agentId: AgentId | undefined): ExitWrite[] | null {
  const profile = profileFor(agentId)
  if (!profile || profile.ctrlCPresses <= 0) return null
  const last = profile.ctrlCPresses - 1
  return Array.from({ length: profile.ctrlCPresses }, (_, i) => ({
    data: CTRL_C,
    gapAfterMs: i === last ? 0 : CTRL_C_GAP_MS,
  }))
}

/**
 * How long to wait for the CLI to release the PTY after the exit sequence before forcing relaunch.
 *
 * ponytail: fixed window, not verification. The alternative is polling the foreground command
 * until the shell returns, but the agent IS the PTY's process (see the header), so there is no
 * shell to ask. Ceiling: a CLI slower than this is killed mid-exit, and `--resume` restores the
 * conversation from its on-disk transcript, losing at most the last message. Upgrade: once the PTY
 * path reports the foreground command (or agents launch inside an interactive shell), poll instead.
 */
export const EXIT_SETTLE_MS = 2500

/** Total duration of an exit sequence, used to schedule the relaunch phase. */
export function exitDurationMs(writes: ExitWrite[]): number {
  return writes.reduce((sum, w) => sum + w.gapAfterMs, 0)
}

/**
 * Send an agent's exit sequence through `write`, honouring the gaps. Resolves after the last write;
 * the caller then waits for the CLI to release the PTY (see `EXIT_SETTLE_MS`).
 *
 * Throws for an agent that cannot be asked to quit rather than silently doing nothing: callers gate
 * on `restartEligibility` first, so reaching this means a wiring bug, not a user choice.
 */
export async function sendExitSequence(
  agentId: AgentId | undefined,
  write: (data: string) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  const writes = exitWrites(agentId)
  if (!writes) throw new Error(`sendExitSequence: agent '${agentId ?? '(none)'}' has no exit sequence`)
  for (const w of writes) {
    write(w.data)
    if (w.gapAfterMs > 0) await sleep(w.gapAfterMs)
  }
}
