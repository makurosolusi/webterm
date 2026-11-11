// Settings › Developer: every raw value for troubleshooting (the ControlPanel table), spending details (cache,
// prefix reuse), and the eval cases
// in a closed disclosure since only people tuning the agents need them.
import { ControlPanel } from './ControlPanel'
import { CostDetails } from './CostPanel'
import { DEVELOPER_TEXT } from './controlPanelLabels'
import { EvalCasesPanel } from './evalcases/EvalCasesPanel'

/** Developer section body; `query` is the Settings search box (already normalized). */
export function DeveloperSection({ query = '' }: { query?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="developer-section">
      <ControlPanel query={query} />
      <CostDetails />
      <details className="text-[13px]">
        <summary className="cursor-default font-semibold">{DEVELOPER_TEXT.evalCases}</summary>
        <EvalCasesPanel />
      </details>
    </div>
  )
}
