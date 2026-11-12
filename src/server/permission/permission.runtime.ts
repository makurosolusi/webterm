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
import { answerPermission, type PermissionAsk } from './permission.wait'
import type { PermissionOutput } from './permission.model'
import { preToolRuleBlock, type PreToolAsk } from './permission.preTool'

/**
 * Answers with the live ledger + policy. `enabled` is `settings.hookReplyApprovals` (Settings >
 * Agents, on by default): off, or no ledger, = no decision, Claude prompts exactly as before.
 */
export async function answerPermissionLive(ask: PermissionAsk, enabled: boolean): Promise<PermissionOutput | null> {
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
    ...(classifierSwitch(ledger.db).permissions ? { classify: (a) => classifyCard({ db: ledger.db }, a) } : {}),
  }, ask)
}

/** PreToolUse: a user Deny rule blocks in every mode (permission.preTool.ts); no policy = nothing to enforce. */
export function preToolRuleLive(ask: PreToolAsk): Record<string, unknown> {
  const policy = activePolicy()
  return policy ? preToolRuleBlock({ policy, record: recordEvent }, ask) : {}
}
