// Settings › Rules & approvals: what agents may do without asking. Policy rules, the auto-approval switches
// with the simulator (both inside PolicySimulator), and the secrets agents may use (SecretsPanel brings its
// own "Secrets" subheading).
import { PolicyRules } from './PolicyRules'
import { PolicySimulator } from './PolicySimulator'
import { SecretsPanel } from './SecretsPanel'

/** Rules & approvals section body. */
export function RulesSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="rules-section">
      <PolicyRules />
      <PolicySimulator />
      <SecretsPanel />
    </div>
  )
}
