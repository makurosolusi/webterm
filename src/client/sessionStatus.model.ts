// The ONE meaning of a session's status, read by every surface that shows it: the Sessions side bar
// (buckets, glyph, row text), node tab strips, the layers panel and the node header chip. Pure and
// DOM-free. Inputs are the hook / agent chat status (`StatusMsg`) plus the server's liveness facts
// (`/api/node-status`), so a live session always has a state: nothing here returns "unknown".
//
// Lifecycle order (Linear / Conductor / Claude Squad): Needs input -> Working -> Idle -> Error -> Exited.
// "Turn ended" is calm Idle, not attention; a failure is Error, not attention. Unread is a flag on Idle.
import type { StatusReasonKind } from '../shared/protocol'
import type { AgentStatus } from '../shared/workspace'

export type StatusBucket = 'needs-input' | 'working' | 'idle' | 'error' | 'exited'
export type StatusTone = 'attention' | 'working' | 'idle' | 'unread' | 'error' | 'muted'

export interface StatusInput {
  /** Hook / agent chat status (`StatusMsg.status`); absent = no claim (fresh, at prompt, swept). */
  status?: AgentStatus
  reason?: StatusReasonKind
  detail?: string
  /** The process ended (`NodeStatusInfo.exit`); without a status this reads Exited. */
  exit?: { code: number }
  /** Spawn sent, no output yet (node header); only used while nothing else is known. */
  starting?: boolean
  /** A turn ended while you were not watching (`./unread`). */
  unread?: boolean
  /** When the current status began (`NodeStatusInfo.statusSince`). */
  since?: number
}

export interface StatusView {
  bucket: StatusBucket
  tone: StatusTone
  /** Codicon name; null = calm, render nothing. `loading` spins (SessionStatusGlyph). */
  icon: string | null
  /** Short state for a header chip: Starting… / Ready / Working / Needs you / Turn ended / Failed / Stopped / Exited. */
  chip: string
  /** Sentence for tooltips, aria labels and row descriptions: "Waiting for approval: Bash". */
  label: string
  unread: boolean
  since?: number
}

export const BUCKET_ORDER: readonly StatusBucket[] = ['needs-input', 'working', 'idle', 'error', 'exited']

/** Section header of each bucket (Sessions side bar, Status grouping). */
export const BUCKET_LABEL: Record<StatusBucket, string> = {
  'needs-input': 'Needs input',
  working: 'Working',
  idle: 'Idle',
  error: 'Error',
  exited: 'Exited',
}

/** Wording of the unread mark: a turn ended while you were not watching. */
export const UNREAD_LABEL = 'Finished — new for you'

type Core = Pick<StatusView, 'bucket' | 'tone' | 'icon' | 'chip' | 'label'>

const needsYou = (label: string): Core => ({ bucket: 'needs-input', tone: 'attention', icon: 'bell', chip: 'Needs you', label })
const failed = (label: string): Core => ({ bucket: 'error', tone: 'error', icon: 'error', chip: 'Failed', label })
const idle = (chip: string, label: string): Core => ({ bucket: 'idle', tone: 'idle', icon: null, chip, label })
const exited = (chip: string, label: string): Core => ({ bucket: 'exited', tone: 'muted', icon: null, chip, label })

function core(i: StatusInput): Core {
  const d = i.detail
  if (i.status === 'blocked') return needsYou(d ? `Waiting for approval: ${d}` : 'Waiting for your approval')
  if (i.status === 'waiting' && i.reason === 'question') return needsYou(questionLabel(d))
  if (i.status === 'waiting' && i.reason === 'error') return failed(d ? `Turn failed: ${d}` : 'Turn failed')
  switch (i.status) {
    case 'working': return { bucket: 'working', tone: 'working', icon: 'loading', chip: 'Working', label: 'Working' }
    case 'waiting': return idle('Turn ended', 'Turn ended')
    case 'failed': return failed(d ? `Error: ${d}` : 'Failed')
    case 'stopped': return exited('Stopped', 'Stopped — can be resumed')
    case 'done': return exited('Exited', exitLabel(i.exit))
  }
  if (i.exit) return exited('Exited', exitLabel(i.exit))
  if (i.starting) return { bucket: 'working', tone: 'working', icon: 'loading', chip: 'Starting…', label: 'Starting…' }
  // No claim and no exit = alive at its prompt (fresh, resumed, swept, a plain shell, a resumable chat).
  return idle('Ready', 'Ready')
}

const questionLabel = (d: string | undefined): string => (d ? `Asked a question: ${d}` : 'Asked a question')
const exitLabel = (exit: { code: number } | undefined): string => (exit && exit.code >= 0 ? `Exited (code ${exit.code})` : 'Exited')

/** The view of one session's status. Unread overrides the tone of Idle only. */
export function sessionStatusView(i: StatusInput): StatusView {
  const c = core(i)
  const unread = !!i.unread && c.bucket === 'idle'
  return {
    ...c,
    ...(unread ? { tone: 'unread' as const, icon: 'circle-filled', label: `${c.label} — ${UNREAD_LABEL}` } : {}),
    unread,
    ...(i.since !== undefined ? { since: i.since } : {}),
  }
}
