// `agent.relay` (RND/30b WS-11): central sends a message to a worker or to itself. The sender is the
// calling conversation (server-side), never a model-supplied field; delivery into a PTY happens only when idle.
import type { MailDeliver } from '../../agents/mailDeliver'
import { MAIL_KINDS, MAX_MAIL_BODY_BYTES, createMailStore, isMailRef } from '../../agents/mailStore'
import type { MailKind } from '../../contracts/mail.types'
import type { ToolDef } from '../toolTypes'
import { obj, S } from '../../../capability/capability.schema'

export const AGENT_MAIL_FLAG = 'WEBTERM_AGENT_MAIL'
const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/
// done/escalate are reports from a worker to central; central itself only starts, asks or answers.
const CENTRAL_KINDS: readonly MailKind[] = MAIL_KINDS.filter((kind) => kind === 'msg' || kind === 'ask' || kind === 'reply')

/** Builds the `agent.relay` def; `deliver` (optional) is flushed right after storing so an idle target gets it now. */
export function createAgentRelayDef(deps: { deliver?: MailDeliver } = {}): ToolDef {
  return {
    name: 'agent.relay',
    summary: 'Send a message to a worker agent of this project; delivered when it is idle. Not an approval.',
    tier: 'R1',
    flag: AGENT_MAIL_FLAG,
    usage: '{"projectId":"<id>","to":"agent:<id>","text":"<=8KB","kind":"msg|ask|reply","threadId":"<optional>","reqId":"<optional idempotency key>"}. The recipient sees it labelled as an agent message, never as human input or approval.',
    input: obj({ to: S.str(), text: S.str(), kind: S.oneOf(...CENTRAL_KINDS), threadId: S.str(200), reqId: S.str(200) }, ['to', 'text']),
    output: S.keys('mailId', 'threadId', 'duplicate', 'delivered'),
    auditKeys: ['mailId', 'threadId', 'delivered'],
    validate(input, ctx) {
      const { to, text, kind, threadId, reqId, from } = input
      const sender = `central:${ctx.conversationId}`
      const ok = isMailRef(to) && typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text, 'utf8') <= MAX_MAIL_BODY_BYTES
        && (kind === undefined || CENTRAL_KINDS.includes(kind as MailKind))
        && (threadId === undefined || (typeof threadId === 'string' && SAFE_ID.test(threadId)))
        && (reqId === undefined || (typeof reqId === 'string' && SAFE_ID.test(reqId)))
        // `from` is accepted only if it names the real sender; anything else is an impersonation attempt.
        && (from === undefined || from === sender)
      return ok ? null : 'invalid_shape'
    },
    async handler(ctx, input, projectId) {
      const store = createMailStore(ctx.db, ctx.now)
      const result = store.send(`central:${ctx.conversationId}`, {
        projectId: projectId as string,
        threadId: typeof input.threadId === 'string' ? input.threadId : '',
        toRef: String(input.to),
        kind: (input.kind as MailKind | undefined) ?? 'msg',
        body: String(input.text),
        reqId: typeof input.reqId === 'string' ? input.reqId : crypto.randomUUID(),
      })
      if (!result.ok) return { ok: false, code: result.code }
      const delivered = deps.deliver ? await deps.deliver.flush(result.mail.toRef) : false
      return { ok: true, data: { mailId: result.mail.id, threadId: result.mail.threadId, duplicate: result.duplicate, delivered } }
    },
  }
}
