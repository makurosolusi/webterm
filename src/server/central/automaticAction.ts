// "The system never changes anything silently": every automatic action is told to the user (a Central notice)
// and leaves a record they can read (a Senses event the Timeline shows). One call does both.
//
// Record contract (the client Timeline builds on this exactly):
//   kind `auto.<name>`, source `auto`, payload `{ text, undo? }`, where `undo` is
//   `{ label, method: 'POST', path: '/api/...', body? }`: a plain authenticated POST that reverses (or, for an
//   offer, applies) the action. The text is one plain English sentence, what happened and why; never a secret
//   or a prompt body (Rule 12).
import type { Database } from 'bun:sqlite'
import type { AppendEventInput } from '../events/eventModel'
import { recordEvent } from '../events/producers'
import { createLogger } from '../logs'
import { redactSecrets } from '../redactSecrets'
import { appendCentralNotice } from './chat/conversationNotice'

const log = createLogger('central')
const TEXT_MAX = 300

/** The button a record offers; `path` stays under `/api/`. */
export interface AutoUndo { label: string; method: 'POST'; path: string; body?: Record<string, unknown> }

export interface AutomaticActionInput {
  /** `auto.<name>` is the record kind. */
  name: string
  text: string
  /** Who acted: `central`, `system:<module>`, `classifier`, ... */
  actor: string
  subject?: string
  workspaceId?: string | null
  nodeId?: string | null
  projectId?: string | null
  undo?: AutoUndo
  /** Notice idempotency key; default `auto:<name>:<subject>`. A repeated key adds neither notice nor record. */
  noticeKey?: string
  /** Record only (high-volume actions such as outbox delivery). */
  noNotice?: boolean
}

export interface AutomaticActionDeps {
  /** The ledger DB holding the Central conversation; null = record only. */
  db: Database | null
  now?: () => number
  /** Senses writer; default the process `recordEvent`. */
  record?: (e: AppendEventInput) => void
}

const clean = (text: string): string => {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat
}

/** Posts the notice and the record; returns false when the key was already noticed. Never throws. */
export function automaticAction(deps: AutomaticActionDeps, input: AutomaticActionInput): boolean {
  const text = clean(input.text)
  const kind = `auto.${input.name}`
  if (!input.noNotice && deps.db) {
    try {
      const key = input.noticeKey ?? `auto:${input.name}:${input.subject ?? ''}`
      if (!appendCentralNotice(deps.db, { key, text, ...(deps.now ? { now: deps.now } : {}) })) return false
    } catch (err) {
      // The record below still lands, so the action stays readable even when the chat write failed.
      log.warn('central.auto_notice_failed', `notice of ${kind} failed`, { kind, error: err instanceof Error ? err.message : String(err) })
    }
  }
  ;(deps.record ?? recordEvent)({
    kind, source: 'auto', actor: input.actor, trust: 'trusted',
    subject: input.subject ?? null, workspaceId: input.workspaceId ?? null, nodeId: input.nodeId ?? null,
    payload: { text, ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.undo ? { undo: input.undo } : {}) },
    ...(deps.now ? { ts: deps.now() } : {}),
  })
  return true
}
