// Production wiring of the permission answerer (F3-b) over the process ledger, policy and settings.
// Kept apart from `permission.wait.ts` so the latter stays testable with an in-memory ledger.
import { syncWorkspaceProjects } from '../central/workspaceLookup'
import { recordEvent } from '../events/producers'
import { PERM_WAIT_SECS_INTERACTIVE } from '../hooksSettings'
import { getRow } from '../ledger/ledgerCore'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { activePolicy } from '../policy/policy.runtime'
import { classifierSwitch } from '../policy/policy.classifier'
import { classifyCard } from '../policy/policy.classifier.card'
import { isEnabled } from '../featureCapabilities.runtime'
import { effectiveLevelOf, levelRank } from '../central/guard/levelStore'
import type { Policy } from '../policy/policy.decide'
import { queueCheckinReason } from '../central/work/workCheckin'
import { kickCheckin } from '../central/work/workCheckin.kick'
import type { Database } from 'bun:sqlite'
import type { PermissionRouting } from '../../shared/settings.permissionRouting'
import { answerPermission, type CentralRoute, type PermissionAsk } from './permission.wait'
import type { PermissionOutput } from './permission.model'
import { preToolRuleBlock, type PreToolAsk } from './permission.preTool'

/** What the hook route passes per request: the `permissionRouting` setting and whether Central may start its own turns. */
export interface RoutingSettings { routing: PermissionRouting; checkins: boolean }

/** Central as the first answerer (docs/decisions/central-approver.md): wakes it through the check-in queue, never by polling. */
export function centralRoute(db: Database, policy: Pick<Policy, 'store'>, checkins: boolean): CentralRoute {
  return {
    unavailable(projectId) {
      if (!isEnabled('central')) return 'Central is off'
      if (!checkins) return 'Central check-ins are off'
      const level = effectiveLevelOf(db, projectId, process.env)
      return levelRank(level) < levelRank(policy.store.tierMinimum('R1')) ? `Central's level (${level}) is too low to decide` : null
    },
    wake({ approvalId, projectId, node, label }) {
      const now = Date.now()
      queueCheckinReason(db, {
        kind: 'permission_request', dedupeKey: `perm:${approvalId}`, projectId, taskId: null, now, notBefore: now,
        text: `worker ${node} waits for a permission decision (approval ${approvalId}) to run ${label}; decide with permission.decide, or escalate when unsure`,
      })
      if (!kickCheckin()) throw new Error('the check-in engine is not running')
    },
  }
}

/**
 * Answers with the live ledger + policy. `enabled` is `settings.hookReplyApprovals` (Settings >
 * Agents, on by default): off, or no ledger, = no decision, Claude prompts exactly as before.
 */
export async function answerPermissionLive(ask: PermissionAsk, enabled: boolean, routing?: RoutingSettings): Promise<PermissionOutput | null> {
  const ledger = activeLedgerRuntime()
  const policy = activePolicy()
  if (!ledger || !policy) return null
  const projectOf = (): string | null => {
    if (!ask.workspaceId) return null
    const r = getRow(ledger.db, 'SELECT id FROM project WHERE workspace_id = ?', ask.workspaceId)
    return r ? String(r['id']) : null
  }
  let projectId = projectOf()
  if (!projectId && ask.workspaceId) {
    syncWorkspaceProjects(ledger.db) // a board never shown to Central has no ledger project yet
    projectId = projectOf()
  }
  return answerPermission({
    db: ledger.db, policy, projectId, record: recordEvent,
    waitMs: enabled ? PERM_WAIT_SECS_INTERACTIVE * 1000 : 0,
    ...(routing?.routing === 'central' ? { central: centralRoute(ledger.db, policy, routing.checkins) } : {}),
    ...(classifierSwitch(ledger.db).permissions ? { classify: (a) => classifyCard({ db: ledger.db }, a) } : {}),
  }, ask)
}

/** PreToolUse: a user Deny rule blocks in every mode (permission.preTool.ts); no policy = nothing to enforce. */
export function preToolRuleLive(ask: PreToolAsk): Record<string, unknown> {
  const policy = activePolicy()
  return policy ? preToolRuleBlock({ policy, record: recordEvent }, ask) : {}
}
