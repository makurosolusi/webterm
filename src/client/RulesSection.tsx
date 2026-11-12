// Settings › Rules & secrets: what agents may do without asking. The rule list with one-click rules from recent
// approvals (PolicyRules), the secrets agents may use (SecretsPanel brings its own "Secrets" subheading), and
// under Advanced the raw rule form and the simulator. How often agents ask at all is Settings › Claude's
// approval level, not a switch here.
import { PolicyRuleForm } from './PolicyRuleForm'
import { PolicyRules } from './PolicyRules'
import { PolicySimulator } from './PolicySimulator'
import { SecretsPanel } from './SecretsPanel'

export const RULES_SECTION_TEXT = { advanced: 'Advanced' } as const

export interface WorkspaceName { id: string; name: string }

/** Rules & secrets section body; `workspaceId` is the workspace the user is in ('' = none). */
export function RulesSection({ workspaceId = '', workspaces = [] }: { workspaceId?: string; workspaces?: readonly WorkspaceName[] }): React.JSX.Element {
  const names = new Map(workspaces.map((w) => [w.id, w.name]))
  const current = workspaceId ? { id: workspaceId, name: names.get(workspaceId) ?? workspaceId } : null
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="rules-section">
      <PolicyRules workspaceNames={names} />
      <SecretsPanel workspace={current} />
      <details data-testid="rules-advanced">
        <summary className="cursor-default font-semibold">{RULES_SECTION_TEXT.advanced}</summary>
        <div className="mt-2 flex flex-col gap-3">
          <PolicyRuleForm />
          <PolicySimulator />
        </div>
      </details>
    </div>
  )
}
