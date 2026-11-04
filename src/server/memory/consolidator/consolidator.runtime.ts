// When the consolidator runs (Letta sleep-time compute: memory upkeep happens while the agent is idle,
// never on its hot path):
//  - idle: a node's `hook.Stop` arms a per-node timer; any later prompt/tool hook of that node disarms it
//    (the agent is busy again); `pty.exit` (session over) arms it too. Debounced: one run per idle period.
//  - nightly: once a night at NIGHT_HOUR, every node seen in the last day gets a pass.
// Runs are serialized (one model call at a time), skip incognito nodes before the transcript is read,
// read only the transcript lines added since the node's last run, and stop at the daily token cap.
// Never throws into the event bus: a failed run is a warn line.
import type { Database } from 'bun:sqlite'
import { withTimeout } from '../../central/context/claudeStructured'
import { readTranscriptFile, renderTranscriptLines } from '../../contextLinkTranscript'
import type { EventBus } from '../../events/eventBus'
import { newId } from '../../ledger/ledgerCore'
import { redactSecrets } from '../../redactSecrets'
import { nodeRef } from '../memoryControls'
import { isIncognito } from '../memoryGuard'
import { CONSOLIDATION_SCHEMA, consolidationPrompt, parseOps, TRANSCRIPT_MAX_CHARS } from './consolidator.model'
import type { ConsolidatorModel } from './consolidator.runner'
import { CONSOLIDATOR_DAILY_TOKENS, knownMemories, recordRunUsage, tokensToday, writeProposals } from './consolidator.store'

export const IDLE_MS = 10 * 60_000
export const NIGHT_HOUR = 3
export const RUN_TIMEOUT_MS = 120_000
/** Output + schema overhead added to the prompt estimate before a run is allowed under the cap. */
const OUTPUT_ESTIMATE_TOKENS = 2_000
const CHARS_PER_TOKEN = 4
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Hooks that mean "the agent is working again". */
const BUSY_HOOKS = new Set(['hook.UserPromptSubmit', 'hook.PreToolUse', 'hook.PostToolUse'])

export interface ConsolidatorDeps {
  db: () => Database | null
  /** Transcript path last reported by the node's hooks. */
  transcriptOf: (nodeId: string) => string | undefined
  model: ConsolidatorModel
  now: () => number
  dailyTokens?: number
  warn?: (message: string, fields: Record<string, unknown>) => void
}

export type RunStatus = 'off' | 'incognito' | 'no_transcript' | 'nothing_new' | 'capped' | 'failed' | 'ok'
export interface RunResult { status: RunStatus; written: string[]; skipped: Array<{ text: string; code: string }> }

const empty = (status: RunStatus): RunResult => ({ status, written: [], skipped: [] })
/** Conversation text only: tool calls and tool results (web pages, file contents) never reach the model. */
const conversational = (l: string): boolean => l.startsWith('user: ') || l.startsWith('assistant: ')

/** One consolidator pass over what a node said since `cursors.get(nodeId)`. */
export async function consolidateNode(deps: ConsolidatorDeps, cursors: Map<string, number>, nodeId: string, sourceEventId: number | null): Promise<RunResult> {
  const db = deps.db()
  if (!db) return empty('off')
  if (isIncognito(db, [nodeRef(nodeId)])) return empty('incognito')
  const path = deps.transcriptOf(nodeId)
  const raw = path ? readTranscriptFile(path) : null
  if (raw === null) return empty('no_transcript')
  const lines = renderTranscriptLines(raw).filter(conversational)
  const from = (cursors.get(nodeId) ?? 0) <= lines.length ? (cursors.get(nodeId) ?? 0) : 0 // shorter = a new transcript
  if (from >= lines.length) return empty('nothing_new')
  const transcript = redactSecrets(lines.slice(from).join('\n')).slice(-TRANSCRIPT_MAX_CHARS)
  const known = knownMemories(db)
  const prompt = consolidationPrompt(transcript, known)
  const now = deps.now()
  if (tokensToday(db, now) + Math.ceil(prompt.length / CHARS_PER_TOKEN) + OUTPUT_ESTIMATE_TOKENS > (deps.dailyTokens ?? CONSOLIDATOR_DAILY_TOKENS)) return empty('capped')
  const answer = await withTimeout((signal) => deps.model({ prompt, schema: CONSOLIDATION_SCHEMA }, signal), RUN_TIMEOUT_MS, 'consolidator')
  recordRunUsage(db, newId(), nodeId, answer.usage, deps.now())
  cursors.set(nodeId, lines.length)
  const out = writeProposals(db, parseOps(answer.output, known), { nodeId, sourceEventId }, deps.now())
  return { status: 'ok', ...out }
}

/** Idle + nightly triggers on the Senses bus; `runNow` is the manual "Review now" path. */
export function createConsolidator(deps: ConsolidatorDeps, bus: Pick<EventBus, 'subscribe'>) {
  const cursors = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const seen = new Map<string, { at: number; seq: number | null }>()
  let chain: Promise<unknown> = Promise.resolve()
  let lastNight = ''
  const warn = deps.warn ?? (() => {})

  const enqueue = (nodeId: string, seq: number | null): Promise<RunResult> => {
    const run = chain.then(() => consolidateNode(deps, cursors, nodeId, seq)).catch((err: unknown) => {
      warn('consolidator run failed; proposals skipped this time', { ids: { nodeId }, cause: err instanceof Error ? err.message : String(err) })
      return empty('failed')
    })
    chain = run
    return run
  }
  const disarm = (nodeId: string): void => { clearTimeout(timers.get(nodeId)); timers.delete(nodeId) }
  const arm = (nodeId: string, seq: number | null): void => {
    disarm(nodeId)
    const t = setTimeout(() => { timers.delete(nodeId); void enqueue(nodeId, seq) }, IDLE_MS)
    t.unref?.()
    timers.set(nodeId, t)
  }
  const offs = [
    bus.subscribe('hook.*', (e) => {
      if (!e.nodeId) return
      const seq = e.seq > 0 ? e.seq : null
      seen.set(e.nodeId, { at: e.ts, seq })
      if (e.kind === 'hook.Stop') arm(e.nodeId, seq)
      else if (BUSY_HOOKS.has(e.kind)) disarm(e.nodeId)
    }),
    bus.subscribe('pty.exit', (e) => { if (e.nodeId && seen.has(e.nodeId)) arm(e.nodeId, seen.get(e.nodeId)?.seq ?? null) }),
  ]
  /** Nightly pass; called hourly, acts once per calendar night. */
  const nightly = (): void => {
    const d = new Date(deps.now())
    const night = d.toDateString()
    if (d.getHours() !== NIGHT_HOUR || night === lastNight) return
    lastNight = night
    for (const [nodeId, s] of seen) if (deps.now() - s.at <= DAY_MS) void enqueue(nodeId, s.seq)
  }
  const tick = setInterval(nightly, HOUR_MS)
  tick.unref?.()
  return {
    runNow: (nodeId: string): Promise<RunResult> => enqueue(nodeId, seen.get(nodeId)?.seq ?? null),
    /** Nodes with hook activity in the last day (for "Review now" over every recent session). */
    recentNodes: (): string[] => [...seen].filter(([, s]) => deps.now() - s.at <= DAY_MS).map(([id]) => id),
    nightly,
    pending: (): number => timers.size,
    dispose(): void { for (const off of offs) off(); for (const id of [...timers.keys()]) disarm(id); clearInterval(tick) },
  }
}

export type Consolidator = ReturnType<typeof createConsolidator>
