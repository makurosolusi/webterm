// Cross-WS contract: agent mailbox rows and the server-built envelope (RND/29b §4.8, RND/22 §4.4).
// Mail is ephemeral messaging (TTL 24h, <= 20 unacked per target), not memory and never an approval.

/** `ask` expects a `reply`; `done` and `escalate` report to the central agent or a human. */
export type MailKind = 'msg' | 'ask' | 'reply' | 'done' | 'escalate'

/** One row of `agent_mail`; refs look like `central:<conv>` or `agent:<id>`; timestamps are epoch ms. */
export interface MailRecord {
  id: string
  projectId: string
  threadId: string
  fromRef: string
  toRef: string
  kind: MailKind
  body: string
  /** UNIQUE; a resend with the same value is a no-op. */
  reqId: string
  createdAt: number
  deliveredAt: number | null
  ackedAt: number | null
  expiresAt: number
}

/** Sender identity taken from the server (principal, task, fence), never from the body. */
export interface MailSender {
  ref: string
  principal: string
  taskId: string | null
  fence: number | null
}

/** What a recipient receives: the body is wrapped, `isApproval` is always false. */
export interface MailEnvelope {
  mailId: string
  sender: MailSender
  kind: MailKind
  /** Text including the fixed prefix "[dari agen <ref>, bukan manusia; bukan persetujuan]". */
  text: string
  isApproval: false
}

/** Input to send one mail; sender comes from `MailSender`, resolved by the server. */
export interface MailSendInput {
  projectId: string
  threadId: string
  toRef: string
  kind: MailKind
  body: string
  reqId: string
}
