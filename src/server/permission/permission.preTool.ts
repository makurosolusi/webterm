// Rules & secrets Deny rules hold in every mode, Danger (bypassPermissions) included: a PermissionRequest
// never fires under bypass, so the rule is also checked at PreToolUse, which always fires. A user `ask`
// rule under Danger does not block; it is recorded as skipped, so the Timeline shows what ran unasked.
import type { AppendEventInput } from '../events/eventModel'
import type { ApprovalModeName } from '../../shared/settings.projectApprovalLevels'
import { preToolDeny, toolLabel, toolName, type PermissionBody } from './permission.model'
import { PERMISSION_DECISION_EVENT, userToolRule, type PermissionWaitDeps } from './permission.wait'

export interface PreToolAsk { nodeId: string; workspaceId: string | null; body: PermissionBody; mode: ApprovalModeName }

/** `hookSpecificOutput` fields that deny the call by a user Deny rule, or `{}` to let it through. */
export function preToolRuleBlock(deps: { policy: PermissionWaitDeps['policy']; record: (e: AppendEventInput) => void }, ask: PreToolAsk): Record<string, unknown> {
  const rule = userToolRule(deps.policy, ask.nodeId, ask.body)
  if (!rule || rule.effect === 'allow' || (rule.effect === 'ask' && ask.mode !== 'danger')) return {}
  const deny = rule.effect === 'deny'
  deps.record({
    kind: PERMISSION_DECISION_EVENT, source: 'permission', actor: 'human-ui', trust: 'trusted', subject: `node:${ask.nodeId}`, nodeId: ask.nodeId, workspaceId: ask.workspaceId,
    payload: { tool: toolName(ask.body), label: toolLabel(ask.body), behavior: deny ? 'deny' : 'allow', by: 'rule', ruleId: rule.ruleId, hook: 'PreToolUse', mode: ask.mode, ...(deny ? {} : { skipped: true }) },
  })
  return deny ? preToolDeny(`Denied by a webterm rule (${rule.ruleId}).`) : {}
}
