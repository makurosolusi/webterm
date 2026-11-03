// Builds checkpoints: deterministic facts always, narrative from an injected summarizer (LLM) with a
// deterministic fallback (RND/23 §4.3). A failed or slow summarizer never blocks rotation.
import type { Database } from 'bun:sqlite'
import { createLogger } from '../../logs'
import {
  collectFacts, insertCheckpoint, latestCheckpoint, messageSeq, recentMessages,
  type Checkpoint, type CheckpointMessage,
} from './checkpointStore'

const log = createLogger('central.checkpoint')

/** Wall-clock cap of one summarizer call. */
export const SUMMARIZER_TIMEOUT_MS = 60_000
/** Messages shown to the summarizer / used by the fallback. */
export const SUMMARY_SPAN_MESSAGES = 40
export const FALLBACK_MESSAGES = 6
export const FALLBACK_MESSAGE_CHARS = 200
const MESSAGE_CHARS_FOR_SUMMARY = 1000

export interface SummarizeInput {
  previousNarrative: string | null
  messages: readonly CheckpointMessage[]
  factsJson: string
}
export interface SummarizeOutput { narrative: string; model?: string; usage?: unknown }
/** LLM call; must stop when `signal` aborts. Real wiring goes through the central runtime (later WS). */
export type Summarize = (input: SummarizeInput, signal: AbortSignal) => Promise<SummarizeOutput>

const head = (m: CheckpointMessage, chars: number): string => `${m.role}: ${m.text.replace(/\s+/g, ' ').slice(0, chars)}`

/** Deterministic narrative: heads of the last messages. */
export function fallbackNarrative(messages: readonly CheckpointMessage[]): string {
  return messages.slice(-FALLBACK_MESSAGES).map((m) => head(m, FALLBACK_MESSAGE_CHARS)).join('\n')
}

function span(db: Database, conversationId: string): { messages: CheckpointMessage[]; previous: Checkpoint | null } {
  const previous = latestCheckpoint(db, conversationId)
  const afterSeq = previous?.toMessageId ? messageSeq(db, previous.toMessageId) : 0
  return { messages: recentMessages(db, conversationId, SUMMARY_SPAN_MESSAGES, afterSeq), previous }
}

/** Synchronous checkpoint (source `fallback`) so rotation always has a seed; reuses an up-to-date one. */
export function createFallbackCheckpoint(db: Database, conversationId: string, now: number): Checkpoint | null {
  const { messages, previous } = span(db, conversationId)
  const last = messages.at(-1)
  if (last === undefined) return previous
  return insertCheckpoint(db, {
    conversationId, fromMessageId: messages[0]?.id ?? null, toMessageId: last.id,
    factsJson: collectFacts(db, conversationId), narrative: fallbackNarrative(messages), source: 'fallback', now,
  })
}

async function runSummarizer(summarize: Summarize, input: SummarizeInput, timeoutMs: number): Promise<SummarizeOutput> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`summarizer timed out after ${timeoutMs}ms`)) }, timeoutMs)
  })
  try { return await Promise.race([summarize(input, controller.signal), timeout]) } finally { clearTimeout(timer) }
}

export interface CreateCheckpointDeps {
  db: Database
  conversationId: string
  summarize: Summarize
  now: () => number
  timeoutMs?: number
}

/** Creates the next checkpoint: `auto` when the summarizer delivers, `fallback` when it throws, times out or is empty. */
export async function createCheckpoint(deps: CreateCheckpointDeps): Promise<Checkpoint | null> {
  const { db, conversationId } = deps
  const { messages, previous } = span(db, conversationId)
  const last = messages.at(-1)
  if (last === undefined) return previous
  const factsJson = collectFacts(db, conversationId)
  const trimmed = messages.map((m) => ({ ...m, text: m.text.slice(0, MESSAGE_CHARS_FOR_SUMMARY) }))
  const base = { conversationId, fromMessageId: messages[0]?.id ?? null, toMessageId: last.id, factsJson, now: deps.now() }
  try {
    const out = await runSummarizer(deps.summarize, { previousNarrative: previous?.narrative ?? null, messages: trimmed, factsJson }, deps.timeoutMs ?? SUMMARIZER_TIMEOUT_MS)
    if (out.narrative.trim() === '') throw new Error('summarizer returned an empty narrative')
    return insertCheckpoint(db, { ...base, narrative: out.narrative, source: 'auto', model: out.model ?? null, usage: out.usage })
  } catch (err) {
    log.warn('central.checkpoint.fallback', 'summarizer failed, using deterministic fallback', { error: err instanceof Error ? err.name : typeof err })
    return insertCheckpoint(db, { ...base, narrative: fallbackNarrative(messages), source: 'fallback' })
  }
}
