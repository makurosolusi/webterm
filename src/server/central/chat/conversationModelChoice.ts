// Per-conversation `/model` choice for Central and the model + effort a turn runs on.
// The choice is stored as the conversation's own `system` notice (no extra column): its client id is
// `model:<alias|auto>:<effort|default>:<uuid>`, so the newest such row is the current choice and the
// user sees the same row in the chat. A choice applies from the next FRESH session only: caches and
// thinking blocks are bound to the model, so a resumed session keeps the model it was started with.
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { getRow } from '../../ledger/ledgerCore'
import { type Effort, type LadderModel, type Tier, MODEL_IDS, resolveModel } from '../../models/modelLadder'
import { type FableTarget, isFableGranted, requestFableGrant } from '../../models/fableGrant'
import { appendMessage, sessionRefFor } from '../conversationStore'
import { claudeModelArg } from '../runtime/claudeOptions'
import { CENTRAL_MODEL_FLAG } from '../runtime/runtimeShared'
import { modelRequest } from '../../models/modelRequest'
import { claudeEnv } from '../../claudeProvider/claudeProvider.store'
import { CentralChatError } from './chatErrors'
import type { StreamHub } from './streamHub'
import { recordEvent, resolveOrCreateConversation } from './turnPersistence'

export const MODEL_CHOICES: readonly (LadderModel | 'auto')[] = ['haiku', 'sonnet', 'opus', 'fable', 'auto']
export const EFFORT_CHOICES: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const PREFIX = 'model:'
const NO_EFFORT = 'default'

export interface ModelChoice { model: LadderModel; effort?: Effort }

/** What a Central turn runs on: `model` is what the CLI gets (alias or a full `claude-*` id). */
export interface CentralTurnModel { model: string | null; alias: LadderModel | null; effort: Effort | null; tier: Tier; reason: string; /** Fable was asked for without a person's grant: it runs on Opus and a grant card is open. */ fableBlocked?: boolean }

/** Validates `/model <model> [effort]`; `auto` = clear the override (null). Throws a 400 otherwise. */
export function parseModelChoice(model: unknown, effort: unknown): ModelChoice | null {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : ''
  const e = typeof effort === 'string' && effort.trim() !== '' ? effort.trim().toLowerCase() : undefined
  if (!MODEL_CHOICES.includes(m as LadderModel)) {
    throw new CentralChatError('invalid_body', `model must be one of ${MODEL_CHOICES.join(', ')}`, 400)
  }
  if (e !== undefined && !EFFORT_CHOICES.includes(e as Effort)) {
    throw new CentralChatError('invalid_body', `effort must be one of ${EFFORT_CHOICES.join(', ')}`, 400)
  }
  if (m === 'auto') return null
  return { model: m as LadderModel, ...(e ? { effort: e as Effort } : {}) }
}

interface StoredChoice { seq: number; choice: ModelChoice | null }

function latestChoice(db: Database, conversationId: string): StoredChoice | null {
  const row = getRow(db, `SELECT seq, client_message_id FROM central_message WHERE conversation_id = ? AND role = 'system'
    AND substr(client_message_id, 1, ?) = ? ORDER BY seq DESC LIMIT 1`, conversationId, PREFIX.length, PREFIX)
  if (!row) return null
  const [, model, effort] = String(row['client_message_id']).split(':')
  const choice = model === 'auto' || !MODEL_CHOICES.includes(model as LadderModel)
    ? null
    : { model: model as LadderModel, ...(effort && effort !== NO_EFFORT ? { effort: effort as Effort } : {}) }
  return { seq: Number(row['seq']), choice }
}

/** True when a `/model` choice came after the conversation's last successful turn: the next turn starts fresh. */
export function modelSwitchPending(db: Database, conversationId: string): boolean {
  const latest = latestChoice(db, conversationId)
  if (!latest) return false
  const last = getRow(db, `SELECT MAX(m.seq) AS s FROM central_turn t JOIN central_message m ON m.id = t.message_id
    WHERE t.conversation_id = ? AND t.status = 'succeeded'`, conversationId)?.['s']
  return last == null || latest.seq > Number(last)
}

function sessionModel(db: Database, conversationId: string, sessionRef: string): string | null {
  const row = getRow(db, `SELECT usage_json FROM central_turn WHERE conversation_id = ? AND status = 'succeeded' AND session_ref = ?
    ORDER BY started_at DESC, rowid DESC LIMIT 1`, conversationId, sessionRef)
  try {
    const model = (JSON.parse(String(row?.['usage_json'] ?? 'null')) as { model?: unknown } | null)?.model
    return typeof model === 'string' && claudeModelArg(model).arg !== undefined ? model : null
  } catch {
    return null // unreadable usage: no pin, the ladder decides
  }
}

/** The model a fresh session would start on for `choice` (null = no conversation override). */
function freshModel(choice: ModelChoice | null, env: NodeJS.ProcessEnv, fableGranted: boolean): CentralTurnModel {
  const setting = claudeModelArg(env[CENTRAL_MODEL_FLAG]).arg
  const pick = resolveModel({ kind: 'central', override: choice ?? (setting ? { model: setting } : null), fableGranted })
  // A full id or proxy name from the setting goes through as typed; the ladder only names it. The ladder's
  // own default never overrides a model the user chose for their provider.
  const model = pick.fableBlocked ? modelRequest('opus', claudeEnv(env)).flag ?? 'opus'
    : choice ? pick.model : setting ?? (pick.model && modelRequest(pick.model, claudeEnv(env)).flag)
  const reason = pick.fableBlocked ? pick.reason : choice ? 'conversation /model' : setting ? 'Central model setting' : pick.reason
  return { model, alias: pick.model, effort: pick.effort, tier: pick.tier, reason, ...(pick.fableBlocked ? { fableBlocked: true } : {}) }
}

/** The grant scope of a conversation: itself, or its project. */
function fableTarget(db: Database, conversationId: string): FableTarget {
  const projectId = getRow(db, 'SELECT project_id FROM central_conversation WHERE id = ?', conversationId)?.['project_id']
  return { kind: 'conversation', id: conversationId, projectId: typeof projectId === 'string' ? projectId : null }
}

/**
 * Model + effort for a Central turn. Precedence: the conversation's `/model` choice, else the
 * `WEBTERM_CENTRAL_MODEL` setting, else the ladder default for `central`. With `resume` (the session
 * being continued) the model that session ran on is kept, so a change waits for a fresh session.
 */
export function centralTurnModel(db: Database, conversationId: string, env: NodeJS.ProcessEnv, resume: string | null): CentralTurnModel {
  const target = fableTarget(db, conversationId)
  const granted = isFableGranted(db, target)
  const fresh = freshModel(latestChoice(db, conversationId)?.choice ?? null, env, granted)
  // Say so once (the card is the notice): a blocked Fable pick opens the grant card, deduped per conversation.
  if (fresh.fableBlocked) requestFableGrant({ db, now: Date.now }, target)
  const pinned = resume ? sessionModel(db, conversationId, resume) : null
  if (!pinned) return fresh
  const kept = resolveModel({ kind: 'central', override: { model: pinned, ...(fresh.effort ? { effort: fresh.effort } : {}) }, fableGranted: granted })
  if (kept.fableBlocked) return fresh // a Fable session whose grant was revoked ends here: the next turn starts fresh on Opus
  return { model: pinned, alias: kept.model, effort: kept.effort, tier: kept.tier, reason: 'session model kept until a fresh session' }
}

export interface ConversationModelState extends CentralTurnModel { override: ModelChoice | null; pending: boolean }

/** What the chat footer shows: the model the next turn runs on and whether a switch is waiting. */
export function conversationModelState(db: Database, conversationId: string, env: NodeJS.ProcessEnv, runtime: string): ConversationModelState {
  const id = resolveOrCreateConversation(db, conversationId).id
  const pending = modelSwitchPending(db, id)
  return { ...centralTurnModel(db, id, env, pending ? null : sessionRefFor(db, id, runtime)), override: latestChoice(db, id)?.choice ?? null, pending }
}

function noticeText(choice: ModelChoice | null, next: CentralTurnModel): string {
  if (next.fableBlocked) return 'Fable needs approval; running on Opus. Approve the request in Needs you (this conversation or the whole project), then pick Fable again to start a fresh session on it.'
  const what = choice ? choice.model : `auto (${next.alias ?? 'default'})`
  const effort = next.effort ? `, ${next.effort} effort` : ''
  const id = next.alias ? ` [${MODEL_IDS[next.alias]}]` : ''
  return `Model set to ${what}${effort}${id}. It applies from a fresh session, which starts with your next message.`
}

/** Stores the choice as a notice in the conversation (published live) and returns the new state. */
export function setConversationModel(
  db: Database, stream: StreamHub, conversationId: string, choice: ModelChoice | null, env: NodeJS.ProcessEnv, runtime: string, now: () => number,
): ConversationModelState {
  const conversation = resolveOrCreateConversation(db, conversationId)
  const { message } = appendMessage(db, {
    conversationId: conversation.id, role: 'system', parts: [{ type: 'notice', text: noticeText(choice, freshModel(choice, env, isFableGranted(db, fableTarget(db, conversation.id)))) }],
    clientMessageId: `${PREFIX}${choice?.model ?? 'auto'}:${choice?.effort ?? NO_EFFORT}:${randomUUID()}`, now: now(),
  })
  recordEvent(db, stream, conversation.id, 'message.created', {
    messageId: message.id, seq: message.seq, role: 'system', parts: message.parts, state: 'complete',
  }, null, message.id, now)
  return conversationModelState(db, conversation.id, env, runtime)
}
