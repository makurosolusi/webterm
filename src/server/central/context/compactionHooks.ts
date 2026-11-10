// Central resumes an SDK session, so the Claude CLI compacts on its own. These programmatic hooks persist the
// work before it does and restore STATE after (docs/decisions/central-orchestrator.md 4E). Checked against
// SDK 0.3.318: a callback's PreCompact instructions travel in `systemMessage` (the CLI takes it as the
// callback's output, which becomes the compaction's custom instructions; there is no PreCompact-specific
// output), and the summary is only exposed as `PostCompactHookInput.compact_summary`, which runs before the
// boundary message is emitted.
import type { Database } from 'bun:sqlite'
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { appendEvent } from '../../ledger/ledgerEvent'
import { createLogger } from '../../logs'
import { redactSecrets } from '../../redactSecrets'
import { checkpointOn } from './contextAssembler'
import { createCheckpoint, createFallbackCheckpoint, type Summarize } from './checkpointSummarizer'
import { buildStateHeader } from './contextHeader'
import { pinnedState, renderPinnedState } from './centralState'

const log = createLogger('central')

/** Audit kind of one compaction; correlation id is the conversation id. */
export const COMPACT_EVENT_KIND = 'central.compact'
/** Bound of the PreCompact summarizer; past it the deterministic fallback checkpoint is written. */
export const PRECOMPACT_CHECKPOINT_TIMEOUT_MS = 20_000
const HOOK_TIMEOUT_SECONDS = 30
const SUMMARY_MAX_CHARS = 4000

/** What the compaction summary must keep. */
export const COMPACTION_INSTRUCTIONS = 'When summarizing, preserve exactly: open assignments and who holds them (task, node, status), decisions made, '
  + 'the user\'s standing instructions, next steps, and file paths.'

/** Compaction wiring of one turn. */
export interface CompactionPort {
  /** SDK hooks; absent when checkpoints are explicitly off. */
  hooks?: Options['hooks']
  /** Sees every SDK message of the turn and records compaction boundaries. */
  onMessage(message: unknown): void
}

export interface CompactionDeps {
  db: Database
  conversationId: string
  env: Record<string, string | undefined>
  now: () => number
  summarize?: Summarize
  checkpointTimeoutMs?: number
}

type CompactBoundary = { type: 'system'; subtype: 'compact_boundary'; compact_metadata: { trigger: string; pre_tokens: number } }
const isCompactBoundary = (m: unknown): m is CompactBoundary =>
  typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'system' && (m as { subtype?: unknown }).subtype === 'compact_boundary'
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err)

/** Builds the hooks and the boundary recorder for one turn of `conversationId`. */
export function createCompactionPort(deps: CompactionDeps): CompactionPort {
  const { db, conversationId, now } = deps
  let summary: string | null = null

  const preCompact: HookCallback = async () => {
    try {
      if (deps.summarize) {
        await createCheckpoint({ db, conversationId, summarize: deps.summarize, now, env: deps.env, timeoutMs: deps.checkpointTimeoutMs ?? PRECOMPACT_CHECKPOINT_TIMEOUT_MS })
      } else {
        createFallbackCheckpoint(db, conversationId, now())
      }
    } catch (err) {
      log.warn('central.compact.checkpoint_failed', 'checkpoint before compaction failed; compacting anyway', { conversationId, error: errorName(err) })
    }
    return { systemMessage: COMPACTION_INSTRUCTIONS }
  }

  const postCompact: HookCallback = async (input) => {
    if (input.hook_event_name === 'PostCompact') summary = input.compact_summary
    return {}
  }

  const sessionStart: HookCallback = async () => {
    try {
      const additionalContext = [buildStateHeader(db, conversationId, now()), renderPinnedState(pinnedState(db, conversationId))].filter((part) => part !== '').join('\n\n')
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }
    } catch (err) {
      log.warn('central.compact.restore_failed', 'could not rebuild state after compaction', { conversationId, error: errorName(err) })
      return {}
    }
  }

  const bounded = (matcher: string, hook: HookCallback) => ({ matcher, hooks: [hook], timeout: HOOK_TIMEOUT_SECONDS })
  return {
    ...(checkpointOn(deps.env) ? {
      hooks: {
        PreCompact: [bounded('manual', preCompact), bounded('auto', preCompact)],
        PostCompact: [bounded('manual', postCompact), bounded('auto', postCompact)],
        SessionStart: [bounded('compact', sessionStart)],
      },
    } : {}),
    onMessage(message) {
      if (!isCompactBoundary(message)) return
      const kept = summary
      summary = null
      try {
        appendEvent({ db, now }, {
          kind: COMPACT_EVENT_KIND, actor: 'central', correlationId: conversationId,
          payload: {
            trigger: message.compact_metadata.trigger, preTokens: message.compact_metadata.pre_tokens, summaryChars: kept?.length ?? 0,
            ...(kept ? { summary: redactSecrets(kept).slice(0, SUMMARY_MAX_CHARS) } : {}),
          },
        })
      } catch (err) {
        log.warn('central.compact.event_failed', 'could not record the compaction', { conversationId, error: errorName(err) })
      }
    },
  }
}
