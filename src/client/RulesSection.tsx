// Settings › Rules & secrets: what agents may do without asking. Cards in order: Rules (the list), From recent
// approvals (one-click rules, only when there are some), Add a rule, Secrets, Secret usage; under Advanced the
// rule try-out (PolicySimulator). How often agents ask at all is Settings › Claude's approval level, not a switch here.
import { PolicyRuleForm } from './PolicyRuleForm'
import { PolicyRules } from './PolicyRules'
import { PolicySimulator } from './PolicySimulator'
import { SecretsPanel } from './SecretsPanel'
import { SettingsAdvanced } from './SettingsControls'

export interface WorkspaceName { id: string; name: string }

/** Rules & secrets section body; `workspaceId` is the workspace the user is in ('' = none). */
export function RulesSection({ workspaceId = '', workspaces = [] }: { workspaceId?: string; workspaces?: readonly WorkspaceName[] }): React.JSX.Element {
  const names = new Map(workspaces.map((w) => [w.id, w.name]))
  const current = workspaceId ? { id: workspaceId, name: names.get(workspaceId) ?? 'this workspace' } : null
  return (
    <div className="flex flex-col" data-testid="rules-section">
      <PolicyRules workspaceNames={names} />
      <PolicyRuleForm />
      <SecretsPanel workspace={current} />
      <div data-testid="rules-advanced" className="contents">
        {/* A tool, not settings: no count in the summary. */}
        <SettingsAdvanced count={0}>
          <PolicySimulator />
        </SettingsAdvanced>
      </div>
    </div>
  )
}
