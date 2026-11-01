// Central chat turn orchestration (RND/08 §4/§7, RND/13 §4 C1): per-conversation
// single-turn lock, `clientMessageId` idempotency, runtime invocation, cancellation.
// Persistence/finalization lives in `turnPersistence`; event projection in
// `turnEvents`; portfolio execution in `toolExecutors`. No plan/task/goal writes.
import type { Database } from 'bun:sqlite'
import { allRows } from '../../ledger/ledgerCore'
import {
  type ConversationError, isActiveTurnStatus, normalizeClientMessageId, validateMessageText,
} from '../conversationModel'
import {
  appendMessage, createTurn, getTurn, updateTurn, type Conversation, type Turn,
} from '../conversationStore'
import type { AppendMessageResponse } from '../centralTypes'
import type { CentralRuntime, RuntimeEvent, RuntimeResult, TurnInput } from '../runtime/centralRuntime'
import { DEFAULT_CENTRAL_TOOLS } from './toolExecutors'
import type { StreamHub } from './streamHub'
import { CentralChatError, chatErrorStatus } from './chatErrors'
import {
  appendAssistantMessage, busyError, findByClientMessageId, finalizeTurn, recordEvent,
  resolveOrCreateConversation, type StoredMessage,
} from './turnPersistence'
import { createRunState, projectRuntimeEvent, type RunState } from './turnEvents'
import { parseProposals } from '../proposal/proposalParser'
import { validateProposal } from '../proposal/proposalPolicy'
import { applyProposal } from '../proposal/applyProposal'
import { centralPrompt } from '../proposal/centralPrompt'
import { buildMemoryContext } from '../memory/contextBuilder'

export { CentralChatError, chatErrorStatus }
export type { ChatErrorCode } from './chatErrors'
export {
  DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, listConversationSummaries, listMessages,
} from './turnPersistence'
export type { MessagePage, StoredMessage } from './turnPersistence'

export interface TurnServiceDeps {
  db: Database
  runtime: CentralRuntime | null
  stream: StreamHub
  now?: () => number
}

export interface SubmitResult {
  response: AppendMessageResponse
  /** Resolves when the background turn is terminal; the HTTP seam ignores it. */
  done: Promise<Turn>
}

const CANCEL_GRACE_MS = 1_500
const HISTORY_LIMIT = 20

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

export class TurnService {
  private readonly db: Database
  private readonly runtime: CentralRuntime | null
  private readonly stream: StreamHub
  private readonly now: () => number
  private readonly runs = new Map<string, Promise<Turn>>()
  private readonly active = new Map<string, string>()
  private readonly states = new Map<string, RunState>()

  constructor(deps: TurnServiceDeps) {
    this.db = deps.db
    this.runtime = deps.runtime
    this.stream = deps.stream
    this.now = deps.now ?? Date.now
  }

  /** Idempotent submit: the same `clientMessageId` replays the same message/turn ids. */
  submit(input: { conversationId: string; clientMessageId?: unknown; text: unknown }): SubmitResult {
    if (this.runtime === null) throw new CentralChatError('central_runtime_off', 'central runtime is off', 503)
    const conversation = resolveOrCreateConversation(this.db, input.conversationId)
    const clientMessageId = normalizeClientMessageId(input.clientMessageId)
    if (clientMessageId === null) throw new CentralChatError('invalid_message', 'clientMessageId is required', 400)
    const text = validateMessageText(input.text)

    const existing = findByClientMessageId(this.db, conversation.id, clientMessageId)
    if (existing) return this.replay(existing)
    if (this.active.has(conversation.id) || conversation.activeTurnId !== null) {
      throw busyError(conversation, this.active.get(conversation.id))
    }
    const history = this.history(conversation.id)
    const appended = appendMessage(this.db, {
      conversationId: conversation.id, role: 'human',
      parts: [{ type: 'text', text }], clientMessageId, now: this.now(),
    })
    if (!appended.created) return this.replay(appended.message)
    const message = appended.message
    this.record(conversation.id, 'message.created', {
      messageId: message.id, seq: message.seq, role: 'human', parts: message.parts,
    }, null, message.id)
    let turn: Turn
    try {
      turn = createTurn(this.db, {
        conversationId: conversation.id, messageId: message.id, runtime: this.runtime.kind, now: this.now(),
      })
    } catch (err) {
      if ((err as ConversationError).code === 'conversation_busy') throw busyError(conversation)
      throw err
    }
    this.active.set(conversation.id, turn.id)
    this.record(conversation.id, 'turn.status', { status: turn.status }, turn.id, null)
    const done = this.runTurn(conversation, turn, text, history)
    this.runs.set(turn.id, done)
    void done.finally(() => {
      this.runs.delete(turn.id)
      if (this.active.get(conversation.id) === turn.id) this.active.delete(conversation.id)
    }).catch(() => undefined)
    return {
      response: { messageId: message.id, seq: message.seq, turnId: turn.id, status: turn.status },
      done,
    }
  }

  /** Cancels through the runtime, then force-closes the turn if it does not settle in time. */
  async cancel(turnId: string): Promise<Turn> {
    const turn = getTurn(this.db, turnId)
    if (!turn) throw new CentralChatError('turn_not_found', `turn not found: ${turnId}`, 404)
    if (!isActiveTurnStatus(turn.status)) return turn
    this.runtime?.cancel(turnId, 'cancelled')
    const run = this.runs.get(turnId)
    if (run) await Promise.race([run.catch(() => undefined), delay(CANCEL_GRACE_MS)])
    const current = getTurn(this.db, turnId)
    if (!current) throw new CentralChatError('turn_not_found', `turn not found: ${turnId}`, 404)
    if (!isActiveTurnStatus(current.status)) return current
    const state = this.states.get(turnId)
    try {
      return updateTurn(this.db, {
        turnId, status: 'cancelled', partialText: state?.text ?? current.partialText, now: this.now(),
      })
    } catch (err) {
      if ((err as ConversationError).code === 'turn_not_active') return getTurn(this.db, turnId) ?? current
      throw err
    }
  }

  async waitFor(turnId: string): Promise<Turn | null> {
    const run = this.runs.get(turnId)
    if (run) await run.catch(() => undefined)
    return getTurn(this.db, turnId)
  }

  private history(conversationId: string): string[] {
    return allRows(
      this.db,
      'SELECT id FROM central_message WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?',
      conversationId, HISTORY_LIMIT
    ).map((row) => String(row['id'])).reverse()
  }

  private async runTurn(
    conversation: Conversation, turn: Turn, text: string, history: string[]
  ): Promise<Turn> {
    const runtime = this.runtime
    if (runtime === null) throw new CentralChatError('central_runtime_off', 'central runtime is off', 503)
    const assistant = appendAssistantMessage(this.db, conversation.id, turn.id, this.now)
    this.record(conversation.id, 'message.created', {
      messageId: assistant.id, seq: assistant.seq, role: 'assistant', parts: [],
    }, turn.id, assistant.id)
    const state = createRunState()
    this.states.set(turn.id, state)
    const emit = (event: RuntimeEvent): void => {
      const projected = projectRuntimeEvent(state, assistant.id, event)
      if (projected) this.record(conversation.id, projected.type, projected.payload, event.turnId, assistant.id)
    }
    const planner = process.env.WEBTERM_CENTRAL_PLANNER === 'on'
    const toolsWrite = process.env.WEBTERM_CENTRAL_TOOLS === 'write'
    const memoryEnabled = process.env.WEBTERM_CENTRAL_MEMORY === 'on'
    const memory = memoryEnabled ? buildMemoryContext(this.db, conversation.id, text, { now: this.now }) : ''
    const input: TurnInput = {
      conversationId: conversation.id, turnId: turn.id,
      text: centralPrompt(this.db, text, planner && toolsWrite, memory), history,
      tools: [...DEFAULT_CENTRAL_TOOLS], limits: {},
      ...(turn.sessionRef === null ? {} : { sessionRef: turn.sessionRef }),
    }
    try {
      const result = await runtime.turn(input, emit)
      if (result.outcome === 'success') this.handleProposals(conversation.id, turn.id, assistant.id, result.text, planner, toolsWrite)
      return finalizeTurn(this.db, this.stream, conversation.id, turn.id, assistant.id, state, result, this.now)
    } catch (err) {
      const result: RuntimeResult = {
        turnId: turn.id, outcome: 'error', text: state.text,
        usage: state.usage, errorCode: 'runtime_error', sessionRef: null,
      }
      this.record(conversation.id, 'error', {
        messageId: assistant.id, code: 'runtime_error',
        message: err instanceof Error ? err.message : 'runtime error', retryable: true,
      }, turn.id, assistant.id)
      return finalizeTurn(this.db, this.stream, conversation.id, turn.id, assistant.id, state, result, this.now)
    } finally {
      this.states.delete(turn.id)
    }
  }

  private handleProposals(
    conversationId: string, turnId: string, messageId: string, text: string, planner: boolean, toolsWrite: boolean
  ): void {
    for (const block of parseProposals(text)) {
      const checked = validateProposal(block, { db: this.db, conversationId, planner, toolsWrite })
      if (!checked.ok) {
        this.record(conversationId, 'entity.updated', { eventType: 'proposal.rejected', tool: block.tool, code: checked.code }, turnId, messageId)
        continue
      }
      const result = applyProposal(this.db, checked.proposal!)
      this.record(conversationId, 'entity.updated', {
        eventType: result.ok ? 'proposal.applied' : 'proposal.rejected', tool: result.tool,
        ...(result.ok ? { projectId: result.projectId, goalVersion: result.goalVersion, planVersion: result.planVersion } : { code: result.code }),
      }, turnId, messageId)
    }
  }

  private record(
    conversationId: string, type: Parameters<typeof recordEvent>[3], payload: unknown,
    turnId: string | null, messageId: string | null
  ): void {
    recordEvent(this.db, this.stream, conversationId, type, payload, turnId, messageId, this.now)
  }

  private replay(message: StoredMessage): SubmitResult {
    const turn = message.turnId === null ? null : getTurn(this.db, message.turnId)
    if (!turn) throw new CentralChatError('turn_not_found', `message ${message.id} has no turn`, 404)
    return {
      response: { messageId: message.id, seq: message.seq, turnId: turn.id, status: turn.status },
      done: this.runs.get(turn.id) ?? Promise.resolve(turn),
    }
  }
}
