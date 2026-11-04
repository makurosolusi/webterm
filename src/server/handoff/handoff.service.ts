// Builds handoff cards and runs "Continue from yesterday" (F5-c). A card is built on demand when the node
// did something since its last card; the narrative comes from the model under a timeout, with a
// deterministic fallback, and the evidence always from `collectEvidence`. Continue injects each agent's
// card through the outbox as a `context` item keyed by the card id, so the same card lands exactly once
// (Claude: the resumed session's SessionStart/UserPromptSubmit additionalContext; others: typed input).
import type { Database } from 'bun:sqlite'
import { withTimeout, type StructuredCall } from '../central/context/claudeStructured'
import type { EventLog } from '../events/eventLog'
import { createLogger } from '../logs'
import type { Workspace, WsNode } from '../../shared/workspace'
import { NARRATIVE_SCHEMA, assembleCard, fallbackNarrative, narrativePrompt, parseNarrative, renderCardForAgent, type HandoffCard, type HandoffNarrative } from './handoff.model'
import { EVIDENCE_WINDOW_MS, collectEvidence, lastActivity, latestCard, storeCard } from './handoff.store'

const log = createLogger('handoff')

export const NARRATIVE_TIMEOUT_MS = 45_000
/** Outbox operationId prefix: one id per card = one delivery per card. */
export const HANDOFF_OP = 'handoff:'

export interface HandoffDeps {
  db: Database
  log: EventLog
  now: () => number
  narrate: StructuredCall
  /** Rendered transcript lines of the node's agent session, oldest first; [] when there is none. */
  transcript: (node: WsNode) => Promise<string[]>
  /** Secret masking + trimming before the transcript leaves for the model. */
  mask: (lines: readonly string[]) => string
  timeoutMs?: number
}

export interface ContinueDeps extends HandoffDeps {
  enqueue(input: { to: string; body: string; kind: 'context'; operationId: string; createdBy: string }): { deduped: boolean }
  /** Why the node cannot take mail, or null. */
  refusal(nodeId: string): string | null
}

export interface ContinueResult { nodeId: string; cardId: string; injected: boolean; skipped?: string }

const titleOf = (n: WsNode): string => n.title?.trim() || n.agentId || n.kind

/** Agent nodes that ran before (a session id was printed for them), in board order. */
export const resumableAgents = (ws: Workspace): WsNode[] => ws.nodes.filter((n) => !!n.agentId && !!n.sessionId)

/** True when the node has no card yet or acted after its newest one. */
export function needsNewCard(db: Database, nodeId: string): boolean {
  const card = latestCard(db, nodeId)
  if (!card) return true
  const active = lastActivity(db, nodeId)
  return active !== null && active > card.createdAt
}

/** Builds and stores a fresh card for `node`. */
export async function buildCard(deps: HandoffDeps, ws: Workspace, node: WsNode): Promise<HandoffCard> {
  const now = deps.now()
  const since = latestCard(deps.db, node.id)?.createdAt ?? now - EVIDENCE_WINDOW_MS
  const evidence = collectEvidence(deps.db, node.id, since)
  const lines = await deps.transcript(node)
  const title = titleOf(node)
  let narrative: HandoffNarrative | null = null
  if (lines.length > 0) {
    try {
      const answer = await withTimeout((signal) => deps.narrate({ prompt: narrativePrompt(title, deps.mask(lines)), schema: NARRATIVE_SCHEMA }, signal), deps.timeoutMs ?? NARRATIVE_TIMEOUT_MS, 'handoff narrative')
      narrative = parseNarrative(answer)
      if (!narrative) log.warn('handoff.narrative.invalid', 'model answer off-schema; using fallback', { ids: { nodeId: node.id } })
    } catch (err) {
      log.warn('handoff.narrative.failed', 'model narrative failed; using fallback', { ids: { nodeId: node.id }, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const card = assembleCard(
    { id: `hc_${crypto.randomUUID()}`, nodeId: node.id, workspaceId: ws.id, title, createdAt: now },
    narrative ?? fallbackNarrative(lines), narrative ? 'model' : 'fallback', evidence,
  )
  storeCard(deps.log, card)
  return card
}

/** The node's current card: the stored one when nothing happened since, else a fresh one. */
export async function currentCard(deps: HandoffDeps, ws: Workspace, node: WsNode): Promise<HandoffCard> {
  return needsNewCard(deps.db, node.id) ? buildCard(deps, ws, node) : (latestCard(deps.db, node.id) as HandoffCard)
}

/** "Continue from yesterday" for one workspace: every resumable agent gets its card, once. */
export async function continueWorkspace(deps: ContinueDeps, ws: Workspace): Promise<ContinueResult[]> {
  return Promise.all(resumableAgents(ws).map(async (node): Promise<ContinueResult> => {
    const card = await currentCard(deps, ws, node)
    const refused = deps.refusal(node.id)
    if (refused) return { nodeId: node.id, cardId: card.id, injected: false, skipped: refused }
    const res = deps.enqueue({ to: node.id, body: renderCardForAgent(card), kind: 'context', operationId: `${HANDOFF_OP}${card.id}`, createdBy: 'handoff' })
    return { nodeId: node.id, cardId: card.id, injected: !res.deduped }
  }))
}
