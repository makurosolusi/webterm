/**
 * Shared types for the central agent surface (route -> store -> runtime -> UI).
 * Re-exports the canonical models so callers never define a second shape, plus
 * the wire DTOs the chat API serializes. No I/O here.
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

/** 202 body; a replay returns the same ids for the same `clientMessageId`. */
export interface AppendMessageResponse {
  messageId: string
  seq: number
  turnId: string
  status: TurnStatus
}

/** Row shown in the conversation list (global, extra chats, one per project). */
export interface ConversationSummary {
  id: string
  scope: string
  projectId: string | null
  activeTurnId: string | null
  lastEventSeq: number
  lastMessageSeq: number
  createdAt: number
  updatedAt: number
  /** First human message, trimmed; null before the first send. */
  title: string | null
  turnCount: number
  /** Role the chat is locked to (`skill-author`); null = ordinary Central chat. */
  mode: string | null
  /** With mode `skill-author`: the existing skill the chat edits; null for a new skill. */
  skillTarget: string | null
}

/** One page of the conversation list, newest first; `nextOffset` null on the last page. */
export interface ConversationPage {
  items: ConversationSummary[]
  nextOffset: number | null
}

/** Stable error envelope: the code is part of the API contract, the message is not. */
export interface CentralErrorBody {
  error: { code: string; message: string }
}
