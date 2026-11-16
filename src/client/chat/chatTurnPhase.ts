// Pure model of "what is the current turn doing", for the inline status row and the screen-reader line.
// No React: the view derives it from the reducer state, so the same inputs always give the same phase.
import { toolLabel } from '../central/toolLabels'
import type { ChatMessage, ChatStreamStatus } from './chatTypes'

export type TurnPhase = 'idle' | 'reconnecting' | 'waiting' | 'streaming' | 'tool' | 'approval'

export interface TurnPhaseInfo {
  phase: TurnPhase
  /** Friendly tool title while `phase` is `tool`. */
  tool?: string
}

export interface TurnPhaseInput {
  stream: ChatStreamStatus
  /** A turn is running (active turn id or an active turn status). */
  busy: boolean
  messages: readonly ChatMessage[]
}

/** The newest reply part of the running turn decides: a live tool, a pending approval, text, or nothing yet. */
export function turnPhase(input: TurnPhaseInput): TurnPhaseInfo {
  if (input.stream === 'reconnecting') return { phase: 'reconnecting' }
  if (!input.busy) return { phase: 'idle' }
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i]
    if (!message || message.role === 'human') break
    for (let j = message.parts.length - 1; j >= 0; j -= 1) {
      const part = message.parts[j]
      if (!part) continue
      if (part.type === 'tool' && (part.state === 'requested' || part.state === 'running')) {
        return { phase: 'tool', tool: toolLabel(part.name, '').title }
      }
      if ((part.type === 'tool' || part.type === 'approval') && part.state === 'awaiting_approval') return { phase: 'approval' }
      if (part.type === 'text' && part.text !== '') return { phase: 'streaming' }
    }
  }
  return { phase: 'waiting' }
}

/** Coarse state the screen reader hears; tool and token changes inside a turn do not change it. */
export type AnnounceState = 'idle' | 'working' | 'reconnecting' | 'failed'

export function announceState(phase: TurnPhase, failed: boolean): AnnounceState {
  if (phase === 'reconnecting') return 'reconnecting'
  if (phase !== 'idle') return 'working'
  return failed ? 'failed' : 'idle'
}

/** One sentence per change of coarse state; `null` = stay silent (first render, dismissing an error). */
export function announcement(prev: AnnounceState, next: AnnounceState): string | null {
  if (prev === next) return null
  if (next === 'working') return prev === 'reconnecting' ? 'Reconnected. Responding…' : 'Responding…'
  if (next === 'reconnecting') return 'Connection lost. Reconnecting…'
  if (next === 'failed') return 'Something went wrong.'
  return prev === 'working' || prev === 'reconnecting' ? 'Response complete.' : null
}
