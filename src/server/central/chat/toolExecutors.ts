// Read-only central tool executors for S0 (RND/08 §5, RND/13 §1).
// `portfolio.read` reads the real ledger projection for the conversation's scope
// and writes exactly one `central.tool` audit event per call: tool name, an
// argument digest, the outcome, and duration. Prompt/text/tokens never enter it.
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { appendEvent } from '../../ledger/ledgerEvent'
import { portfolio, projectPortfolio } from '../centralProjection'
import { type PortfolioEntry } from '../centralModel'
import { scopeFromConversationId, type ConversationScope } from '../conversationModel'
import type { MockToolExecutor, MockToolRequest } from '../runtime/mockRuntime'

export const PORTFOLIO_READ_TOOL = 'portfolio.read'
/** Default S0 allowlist: reads only; no goal/plan/task mutations exist here. */
export const DEFAULT_CENTRAL_TOOLS: readonly string[] = [PORTFOLIO_READ_TOOL]

const GLOBAL_PROJECT_LIMIT = 50
const DIGEST_HEX = 16

export interface PortfolioReadExecutorOptions {
  now?: () => number
}

/** Short, stable digest of tool arguments only (never the prompt). */
export function argumentDigest(input: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(input ?? null) ?? 'null'
  } catch {
    serialized = 'unserializable'
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, DIGEST_HEX)
}

function projectSummary(entry: PortfolioEntry): Record<string, unknown> {
  return {
    id: entry.id,
    name: entry.name,
    status: entry.status,
    priority: entry.priority,
    planVersion: entry.plan?.version ?? null,
    tasks: {
      total: entry.taskTotal,
      pending: entry.tasks.pending,
      leased: entry.tasks.leased,
      verified: entry.tasks.verified,
      failed: entry.tasks.failed,
    },
    pendingApprovals: entry.pendingApprovals,
    budget: entry.budget,
    usage: entry.usage,
  }
}

function readPortfolio(
  db: Database,
  scope: ConversationScope
): { ok: boolean; output: unknown; errorCode?: string; projectId: string | null } {
  if (scope.kind === 'project') {
    const entry = projectPortfolio(db, scope.projectId)
    if (!entry) {
      return {
        ok: false,
        errorCode: 'project_not_found',
        output: { scope: `project:${scope.projectId}`, projectId: scope.projectId, found: false },
        projectId: null,
      }
    }
    return { ok: true, output: { scope: `project:${scope.projectId}`, project: projectSummary(entry) }, projectId: entry.id }
  }
  const page = portfolio(db, { limit: GLOBAL_PROJECT_LIMIT, offset: 0 })
  return {
    ok: true,
    output: {
      scope: 'global',
      total: page.total,
      returned: page.items.length,
      projects: page.items.map(projectSummary),
    },
    projectId: null,
  }
}

/**
 * Builds the `portfolio.read` executor shared by the mock runtime and (later)
 * the real adapter. Every call audits once, including failures; an audit write
 * failure never changes the tool result.
 */
export function createPortfolioReadExecutor(
  db: Database,
  options: PortfolioReadExecutorOptions = {}
): MockToolExecutor {
  const now = options.now ?? Date.now
  return (request: MockToolRequest): { ok: boolean; output?: unknown; errorCode?: string } => {
    const startedAt = now()
    if (request.name !== PORTFOLIO_READ_TOOL) {
      return { ok: false, errorCode: 'unknown_tool', output: { tool: request.name, error: 'unknown_tool' } }
    }
    let scope: ConversationScope
    try {
      scope = scopeFromConversationId(request.conversationId)
    } catch {
      return { ok: false, errorCode: 'invalid_conversation', output: { error: 'invalid_conversation' } }
    }
    const result = readPortfolio(db, scope)
    const durationMs = Math.max(0, now() - startedAt)
    try {
      appendEvent(
        { db, now },
        {
          actor: 'central',
          kind: 'central.tool',
          ...(result.projectId === null ? {} : { projectId: result.projectId }),
          payload: {
            tool: PORTFOLIO_READ_TOOL,
            argsDigest: argumentDigest(request.input),
            scope: request.conversationId,
            ok: result.ok,
            ...(result.errorCode === undefined ? {} : { code: result.errorCode }),
            durationMs,
          },
        }
      )
    } catch {
      // Best-effort audit: a failed insert must not turn a successful read into a
      // tool error, and the payload is deliberately not logged (it may hold ids).
    }
    return result.ok
      ? { ok: true, output: result.output }
      : { ok: false, errorCode: result.errorCode, output: result.output }
  }
}
