/**
 * Shared types for the central agent surface (route -> store -> runtime -> UI).
 * Re-exports the canonical models so callers never define a second shape, plus
 * the wire DTOs the Phase C chat API will serialize. No I/O here.
 */
export type {
  Goal, GoalContent, GoalDraftInput, GoalEnvelope, GoalErrorCode, GoalStatus, SuccessCriterion,
} from './goalModel'
export { GoalError } from './goalModel'
export type { GoalActor } from './goalStore'
export type {
  CentralEventType, ConversationErrorCode, ConversationScope, MessagePart, MessageRole,
  MessageState, RiskClass, ToolCardState, TurnStatus,
} from './conversationModel'
export { ConversationError } from './conversationModel'
import type { TurnStatus } from './conversationModel'
export type { Conversation, ConversationEvent, Message, Turn } from './conversationStore'

/** `POST /api/central/conversations/:id/messages` body (after transport auth). */
export interface AppendMessageRequest {
  clientMessageId: string
  text: string
  replyTo?: string
}

/** 202 body; a replay returns the same ids for the same `clientMessageId`. */
export interface AppendMessageResponse {
  messageId: string
  seq: number
  turnId: string
  status: TurnStatus
}

/** Row shown in the conversation list (global + one per project). */
export interface ConversationSummary {
  id: string
  scope: string
  projectId: string | null
  activeTurnId: string | null
  lastEventSeq: number
  lastMessageSeq: number
  updatedAt: number
}

/** SSE frame payload; `seq` is the replay cursor (`Last-Event-ID`). */
export interface CentralEventDto {
  conversationId: string
  seq: number
  type: string
  turnId?: string
  messageId?: string
  payload?: unknown
  createdAt: number
}

export interface GoalView {
  projectId: string
  goal: import('./goalModel').Goal | null
}

/** Stable error envelope: the code is part of the API contract, the message is not. */
export interface CentralErrorBody {
  error: { code: string; message: string }
}

/** `409` body when a second send arrives while a turn is live. */
export interface ConversationBusyBody extends CentralErrorBody {
  error: { code: 'conversation_busy'; message: string; activeTurnId: string | null }
}
