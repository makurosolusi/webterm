// Vocabulary of the recovery sweep (workRecover.ts): names, bounded limits and the shapes shared by detection, the
// ladder and the orchestrator. Every threshold marked "guess" is untuned: re-tune from real outage data.
import type { AssignmentView, TaskView } from '../../../shared/centralWork'
import type { AgentOwner, AgentRole, AgentRunner, AgentState } from '../contracts'
import type { FailureKind } from './workFailureKind'
import type { WorkSupervisorPorts } from './workSupervisor'

export const RECOVER_EVENT = 'work.recover'
/** One per sweep key, written when the first sweep of that key ran: the idempotency record that survives a restart. */
export const SWEPT_EVENT = 'work.recover.swept'
export const BOOT_EVENT = 'work.recover.boot'
export const SUMMARY_EVENT = 'connectivity.recovery'
export const REQUEUE_EVENT = 'work.checkin_requeued'
export const RECOVER_ACTOR = 'system:work.recover'
/** Rule of the status hop a replaced session needs (running has no edge to assigned): the check-in engine does not wake Central for it. */
export const RECOVER_RULE = 'recover'
/** Tool name the guard judges (R1: it only nudges or relaunches work a human already started). */
export const RECOVER_TOOL = 'work.recover'

/** Hard limits per task and sweep key (the episode): after them a human decides. */
export const MAX_REPROMPTS = 2 // guess
export const MAX_RESUMES = 2
export const MAX_RESPAWNS = 1
/** A check-in reason whose turn died on the network is queued again at most this many times. */
export const MAX_CHECKIN_REQUEUES = 3

/** Wait after the link is back before the sweep (the same grace the penalties get: workHold RECOVERY_GRACE_MS). */
export const SWEEP_GRACE_MS = 60_000
/** Failures this close before the detector declared the episode (it needs three failed probes) still belong to it. */
export const WINDOW_BEFORE_MS = 2 * 60_000 // guess
/** And this close after it ended. */
export const WINDOW_AFTER_MS = 2 * 60_000 // guess
/** Gap between follow-up sweeps for victims that had to wait (busy agent, paused project, full worker quota). */
export const RETRY_SWEEP_MS = 2 * 60_000 // guess
/** Past this after the window a waiting victim goes to a human: Claude Code only continues a cut-off turn within 6 hours (documented). */
export const RECOVERY_HORIZON_MS = 6 * 60 * 60_000
/** `setTimeout` may fire a hair early; the rate-limit sweep is scheduled this far after the reset instant. */
export const TIMER_SLACK_MS = 1_000 // guess
/** How far back a rate-limit sweep looks for interrupted work. */
export const RATE_LIMIT_LOOKBACK_MS = 6 * 60 * 60_000

export type Outcome = 'recovered' | 'rescheduled' | 'escalated'
/** 0 = no action taken (waiting, self-healed or handed to a human); 1 = continue prompt; 2 = `--resume`; 3 = clean respawn. */
export type Rung = 0 | 1 | 2 | 3

export interface Victim {
  task: TaskView
  /** The open attempt, or the last one when it already ended (`ended`). */
  assignment: AssignmentView
  kind: FailureKind
  ended: boolean
  /** Epoch ms the interruption was recorded; a signal after it means the work carried on by itself. */
  at: number
  /** Set for a check-in victim: the reason to queue again. */
  reasonId?: string
}

export interface Verdict { outcome: Outcome; rung: Rung; reason: string; acted: boolean }

export interface SweepWindow { from: number; to: number }
/** What the one summary of a sweep says it was about: a connection outage (`to` null = still open at boot) or a rate-limit reset. */
export interface SweepInfo { what: 'connection' | 'rate_limit'; episodeId: string | null; from: number; to: number | null }
export interface SweepKey {
  key: string
  window: SweepWindow
  /** Only this class of failure belongs to the key (rate-limit sweeps); undefined = every transient class. */
  only?: FailureKind
  info: SweepInfo
}

/** What the ladder reads of an agent row. */
export interface AgentInfo { id: string; state: AgentState; runner: AgentRunner; kind: string; role: AgentRole; owner: AgentOwner; nodeId: string | null }

export type PermitResult = { ok: true } | { ok: false; code: string }
export type RespawnResult = { ok: true; agentId: string; nodeId: string } | { ok: false; code: string }
export type ResumeOutcome = { ok: true } | { ok: false; code: string }

/** What the sweep needs from the world; production adapters live in workRecover.ports.ts, tests pass fakes. */
export interface RecoverPorts extends Pick<WorkSupervisorPorts, 'isLive' | 'submit' | 'chatBusy' | 'chatNodeGone' | 'chatSend'> {
  /** Same guard door Central's tools use (level, project pause, budget, audit). */
  permit(projectId: string, tool: string): PermitResult
  agent(agentId: string): AgentInfo | null
  /** A terminal node sits at its prompt (not working). */
  terminalIdle(nodeId: string): boolean
  /** The continue prompt to a live idle agent (`repromptContinue`). */
  reprompt(agentId: string): Promise<{ ok: boolean; code?: string }>
  /** `resumeAgent` and, when it launched, the typed revive of the agent row. */
  resume(agentId: string): Promise<ResumeOutcome>
  /** A clean agent through the executor's spawn path (guard, caps, approval card and ledger included). */
  respawn(input: { projectId: string; kind: string; role: AgentRole; owner: AgentOwner; title: string; taskId: string; reqId: string }): Promise<RespawnResult>
  /** Brief for the fresh agent; false when it could not be typed now (the boot prompt still carries the task). */
  brief(agentId: string, text: string): Promise<boolean>
}
