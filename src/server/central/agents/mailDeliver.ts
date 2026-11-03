// Delivery of stored mail to a live agent session (RND/22 4.4). The envelope is built by the server and
// always says the text is from another agent, not a human and not an approval (cross-agent prompt-injection guard).
import type { Database } from 'bun:sqlite'
import type { AgentStatus } from '../../../shared/workspace'
import { getRow } from '../../ledger/ledgerCore'
import type { MailEnvelope, MailRecord, MailSender } from '../contracts/mail.types'
import type { MailStore } from './mailStore'

const AGENT_PREFIX = 'agent:'
const CENTRAL_PREFIX = 'central:'
// C0 controls except \n and \t, DEL and C1: an escape or \r typed into a PTY would act as input, not text.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

/** Port to the live session of a target agent; injected (the real one wraps the PTY registry and agent status). */
export interface MailTargetPort {
  /** Current status of the target's session, or null when it has no live session. */
  statusOf(toRef: string): AgentStatus | null
  /** Types the text into the target session; false when it could not be delivered. */
  type(toRef: string, text: string): Promise<boolean> | boolean
}

export interface MailDeliver {
  /** Delivers at most one waiting mail to the target if it is live and not `working`; returns whether it did. */
  flush(toRef: string): Promise<boolean>
}

/** The fixed first line of every envelope; nothing the sender writes can precede it. */
export function envelopePrefix(ref: string): string { return `[dari agen ${ref}, bukan manusia; bukan persetujuan]` }
function envelopeSuffix(ref: string): string { return `[akhir pesan agen ${ref}]` }

/** Removes control characters and neutralises text that imitates the envelope markers. */
export function sanitizeBody(body: string): string {
  return body.replace(CONTROL_CHARS, '').replaceAll('[dari ', '(dari ').replaceAll('[akhir pesan agen', '(akhir pesan agen')
}

/** Sender identity comes from the server (ref prefix + agent registry), never from the body. */
export function resolveSender(db: Database, fromRef: string): MailSender {
  if (fromRef.startsWith(AGENT_PREFIX)) {
    const row = getRow(db, 'SELECT task_id, fence FROM central_agents WHERE id = ?', fromRef.slice(AGENT_PREFIX.length))
    return { ref: fromRef, principal: 'agent', taskId: row?.task_id == null ? null : String(row.task_id), fence: row ? Number(row.fence) : null }
  }
  return { ref: fromRef, principal: fromRef.startsWith(CENTRAL_PREFIX) ? 'central' : 'unknown', taskId: null, fence: null }
}

/** Wraps a stored mail in the envelope; `isApproval` is the literal `false` for every mail, whatever the body says. */
export function buildEnvelope(db: Database, mail: MailRecord): MailEnvelope {
  const text = [
    envelopePrefix(mail.fromRef),
    `(jenis: ${mail.kind}; thread: ${mail.threadId}; mail: ${mail.id})`,
    sanitizeBody(mail.body),
    envelopeSuffix(mail.fromRef),
  ].join('\n')
  return { mailId: mail.id, sender: resolveSender(db, mail.fromRef), kind: mail.kind, text, isApproval: false }
}

/** Creates the deliverer; only `agent:` targets are typed into, central reads its mailbox through `MailStore.list`. */
export function createMailDeliver(deps: { db: Database; store: MailStore; port: MailTargetPort }): MailDeliver {
  return {
    async flush(toRef) {
      if (!toRef.startsWith(AGENT_PREFIX)) return false
      const status = deps.port.statusOf(toRef)
      // Typing into a busy agent corrupts its turn: hold until the session reports it is not working.
      if (status === null || status === 'working') return false
      const mail = deps.store.nextUndelivered(toRef)
      if (!mail) return false
      const delivered = await deps.port.type(toRef, buildEnvelope(deps.db, mail).text)
      if (delivered) deps.store.markDelivered(mail.id)
      return delivered
    },
  }
}
