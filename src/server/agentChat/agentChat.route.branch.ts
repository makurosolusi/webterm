// Branch verbs of the agent chat route: `POST rewind` (Rewind to here: SDK Query.rewindFiles, a dry run
// first, then the real one) and `POST fork` (Edit a sent message: SDK forkSession up to the entry before
// it, the node switches to the fork, the edited text is sent there; the old session stays in History).
// Never while a turn runs. Docs: code.claude.com/docs/en/agent-sdk/file-checkpointing.
import { forkSession as sdkForkSession, type ForkSessionOptions, type ForkSessionResult, type RewindFilesResult, type SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentChatRewindResult } from '../../shared/agentChat.wire'
import { createLogger } from '../logs'
import { json } from '../routes/route.core'
import { AGENT_CHAT_BUSY_SWITCH_REASON, type AgentChatPool } from './agentChat.pool'
import { loadTranscript, type LoadTranscript } from './agentChat.history'
import { AGENT_CHAT_SEND_BODY_MAX_BYTES, parseSend } from './agentChat.route.attach'
import { bad, fail, readObject, type Ctx, type Fail } from './agentChat.route.core'
import type { AgentChatSession } from './agentChat.session'

const log = createLogger('agent-chat')

export const BRANCH_VERBS: Record<string, 'GET' | 'POST'> = { rewind: 'POST', fork: 'POST' }
/** A user message id: the uuid the session streamed (or the transcript's). */
const MESSAGE_ID = /^[0-9a-zA-Z-]{1,100}$/
export const AGENT_CHAT_BUSY_BRANCH_REASON = 'Claude is working in this chat. Stop it or wait for the turn to end first.'

export type ForkSession = (sessionId: string, o?: ForkSessionOptions) => Promise<ForkSessionResult>
export interface BranchDeps { pool: AgentChatPool; load?: LoadTranscript; forkSession?: ForkSession }

const busy = (): Fail => ({ status: 409, error: 'busy', reason: AGENT_CHAT_BUSY_BRANCH_REASON })
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err)

export function rewindResult(r: RewindFilesResult): AgentChatRewindResult {
  return {
    canRewind: r.canRewind, ...(r.error ? { error: r.error } : {}), filesChanged: r.filesChanged ?? [],
    insertions: r.insertions ?? 0, deletions: r.deletions ?? 0, ...(r.skippedLinks ? { skippedLinks: r.skippedLinks } : {}),
  }
}

/**
 * Fork point of an edit: the transcript entry right before user message `messageId` (forkSession keeps
 * up to it, inclusive). `upTo` undefined = the first message: the edit starts a fresh conversation.
 */
// No `dir` on forkSession, as on the transcript read: a symlinked cwd would not match the project dir.
export function forkPoint(msgs: readonly SessionMessage[], messageId: string): { upTo?: string } | undefined {
  const at = msgs.findIndex((m) => m.type === 'user' && m.uuid === messageId)
  if (at < 0) return undefined
  const prev = msgs[at - 1]
  return prev ? { upTo: prev.uuid } : {}
}

async function rewind(c: Ctx, deps: BranchDeps, nodeId: string, s: AgentChatSession, messageId: string, dryRun: boolean): Promise<true> {
  const r = await deps.pool.control(nodeId, (q) => q.rewindFiles(messageId, { dryRun }))
  if (!r) return fail(c, { status: 404, error: 'not_found', reason: 'No agent chat node with this id.' })
  if (!r.ok) {
    log.warn('agent_chat.rewind_refused', 'agent chat rewind refused', { ids: { nodeId }, operation: 'rewind', status: r.status })
    return fail(c, { status: r.status, error: r.status === 409 ? 'unavailable' : 'rewind_failed', reason: r.reason })
  }
  const result = rewindResult(r.value)
  if (!dryRun && result.canRewind) {
    const n = result.filesChanged.length
    s.notify('info', `Rewound ${n} file${n === 1 ? '' : 's'} to their state before the selected message. The conversation was not changed.`)
  }
  json(c.res, 200, result)
  return true
}

async function fork(c: Ctx, deps: BranchDeps, nodeId: string, messageId: string, body: Record<string, unknown>): Promise<true> {
  const m = parseSend(body)
  if ('reason' in m) return fail(c, bad(m.reason))
  const sessionId = deps.pool.sessionId(nodeId)
  if (!sessionId) return fail(c, { status: 404, error: 'not_found', reason: 'This chat has no transcript yet.' })
  let point: { upTo?: string } | undefined
  try {
    point = forkPoint(await (deps.load ?? loadTranscript)(sessionId), messageId)
  } catch (err) {
    log.error('agent_chat.fork_failed', 'agent chat transcript read failed', { ids: { nodeId }, operation: 'fork', error: errorName(err) })
    return fail(c, { status: 502, error: 'transcript_unreadable', reason: 'The Claude transcript of this chat could not be read.' })
  }
  if (!point) return fail(c, { status: 404, error: 'not_found', reason: 'That message is not in the saved transcript of this chat.' })
  let target: string | undefined
  if (point.upTo) {
    try {
      target = (await (deps.forkSession ?? sdkForkSession)(sessionId, { upToMessageId: point.upTo })).sessionId
    } catch (err) {
      log.error('agent_chat.fork_failed', 'agent chat fork failed', { ids: { nodeId }, operation: 'fork', error: errorName(err) })
      return fail(c, { status: 502, error: 'fork_failed', reason: `The conversation could not be forked: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  const sw = deps.pool.switchTo(nodeId, target)
  if (sw && !sw.ok) return fail(c, { status: sw.status, error: sw.reason === AGENT_CHAT_BUSY_SWITCH_REASON ? 'busy' : 'session_locked', reason: sw.reason })
  const sent = deps.pool.send(nodeId, m.text, undefined, m.images)
  if (sent && !sent.ok) return fail(c, { status: sent.status, error: 'session_locked', reason: sent.reason })
  json(c.res, 200, { ok: true, ...(target ? { sessionId: target } : {}) })
  return true
}

export async function branchVerb(c: Ctx, deps: BranchDeps, nodeId: string, verb: string, s: AgentChatSession): Promise<true> {
  const read = await readObject(c, verb === 'fork' ? AGENT_CHAT_SEND_BODY_MAX_BYTES : undefined)
  if ('fail' in read) return fail(c, read.fail)
  const b = read.body
  if (typeof b.messageId !== 'string' || !MESSAGE_ID.test(b.messageId)) return fail(c, bad('messageId must be the id of a user message.'))
  if (s.busy()) return fail(c, busy())
  if (verb === 'fork') return fork(c, deps, nodeId, b.messageId, b)
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return fail(c, bad('dryRun must be a boolean.'))
  return rewind(c, deps, nodeId, s, b.messageId, b.dryRun === true)
}
