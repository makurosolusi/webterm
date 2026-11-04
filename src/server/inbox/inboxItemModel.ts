// The unified inbox item (F3-a), pure: no I/O, no bun:sqlite, vitest-safe.
//
// Imitated: LangChain Agent Inbox (github.com/langchain-ai/agent-inbox, archived 2026-09-20, used as a
// UX reference only). Its `HumanInterrupt` carries `config: { allow_accept, allow_edit, allow_respond,
// allow_ignore }` and the human answers with `HumanResponse.type = accept | edit | response | ignore`.
// Here those are `approve | edit | reply | ignore`, plus `deny` (a gate is consent, so refusing is a
// first-class answer) and `snooze` (Orca/email style "later"). The four kinds are the ambient-agent
// HITL patterns notify / question / review (langchain.com/blog/introducing-ambient-agents) plus gate.
import type { AppendEventInput } from '../events/eventModel'

export type InboxItemKind = 'notify' | 'question' | 'review' | 'gate'
export type InboxItemStatus = 'open' | 'done' | 'ignored'
export type InboxActionType = 'approve' | 'deny' | 'edit' | 'reply' | 'ignore' | 'snooze' | 'always'
export type ImpactTier = 'R0' | 'R1' | 'R2' | 'R3'

export const INBOX_ITEM_KINDS: readonly InboxItemKind[] = ['notify', 'question', 'review', 'gate']

/** What approving will do, in one line: the approval-fatigue antidote (PLAN/rnd/04 §3 pitfall). */
export interface Impact {
  what: string
  tier: ImpactTier
  /** False = effects outside the workspace files (network, push, publish) that no checkpoint undoes. */
  rewindable: boolean
}

export interface InboxEntry {
  id: string
  kind: InboxItemKind
  /** `approval` (mirrored ledger approval), `digest`, or the producer name. */
  source: string
  projectId: string | null
  workspaceId: string | null
  nodeId: string | null
  approvalId: string | null
  /** Ledger approval kind for gates (`agent.permission`, `inbox.gate`, ...). */
  approvalKind: string | null
  title: string
  body: string | null
  impact: Impact | null
  args: unknown
  status: InboxItemStatus
  resolution: string | null
  snoozeUntil: number | null
  /** Coalesced repeats of the same news (dedupe key). */
  count: number
  actions: InboxActionType[]
  createdAt: number
  updatedAt: number
}

export type InboxAction =
  | { type: 'approve' }
  | { type: 'deny'; reason?: string }
  | { type: 'edit'; args: unknown }
  | { type: 'reply'; text: string }
  | { type: 'ignore' }
  | { type: 'snooze'; until: number }
  /** Claude permission gates only, canvas only (K4): writes a permanent rule, then allows. Never on Telegram. */
  | { type: 'always' }

/** Agent Inbox `allow_*` per kind. `edit` only where the producer reads the edited args back. */
export function allowedActions(kind: InboxItemKind, editable: boolean): InboxActionType[] {
  switch (kind) {
    case 'gate': return editable ? ['approve', 'edit', 'deny', 'ignore', 'snooze'] : ['approve', 'deny', 'ignore', 'snooze']
    case 'question': return ['reply', 'ignore', 'snooze']
    case 'review': return ['approve', 'reply', 'ignore', 'snooze']
    case 'notify': return ['ignore', 'snooze']
  }
}

/** Never-rewindable effects: they leave the machine (Claude Code keeps `git push` an ask rule in every mode). */
const OUTSIDE = /\b(git\s+push|npm\s+publish|bun\s+publish|gh\s+(pr|release|repo)|curl|wget|ssh|scp|rsync|deploy|docker\s+push)\b/i
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'])
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** Impact of a Claude tool call; heuristic on purpose, the tier only ever rises for outside effects. */
export function toolImpact(tool: string, label: string): Impact {
  if (OUTSIDE.test(label)) return { what: `Runs ${label}, which reaches outside this machine`, tier: 'R3', rewindable: false }
  if (READ_ONLY_TOOLS.has(tool)) return { what: `Reads with ${label}; nothing changes`, tier: 'R0', rewindable: true }
  if (FILE_TOOLS.has(tool)) return { what: `Changes files with ${label}`, tier: 'R1', rewindable: true }
  if (tool === 'Bash') return { what: `Runs the shell command ${label}`, tier: 'R2', rewindable: true }
  return { what: `Runs ${label}`, tier: 'R2', rewindable: false }
}

/** `Runs Bash(npm publish) · R3 · cannot be rewound` */
export function impactLine(impact: Impact): string {
  return `${impact.what} · ${impact.tier} · ${impact.rewindable ? 'rewindable from a checkpoint' : 'cannot be rewound'}`
}

/** Event every gate decision produces, whichever surface (canvas or Telegram) made it. */
export const INBOX_DECISION_EVENT = 'inbox.decision'
/** Every other inbox action (reply, ignore, snooze, edit-approve details). */
export const INBOX_ACTION_EVENT = 'inbox.action'

/** One shape for both surfaces, so "approved from Telegram" and "approved on canvas" are the same fact. */
export function gateDecisionEvent(input: { approvalId: string; approve: boolean; actor: string; edited?: boolean }): AppendEventInput {
  return {
    kind: INBOX_DECISION_EVENT,
    source: 'inbox',
    actor: /^[\w.:-]{1,64}$/.test(input.actor) ? input.actor : 'human',
    trust: 'trusted',
    subject: `approval:${input.approvalId}`,
    payload: { approvalId: input.approvalId, decision: input.approve ? 'approve' : 'deny', edited: input.edited === true },
  }
}
