// Settings › Developer: every raw value for troubleshooting (the ControlPanel table), and the eval cases
// in a closed disclosure since only people tuning the agents need them.
import { ControlPanel } from './ControlPanel'
import { DEVELOPER_TEXT } from './controlPanelLabels'
import { EvalCasesPanel } from './evalcases/EvalCasesPanel'

/** Developer section body (shown in the nav only in developer mode, ./developerMode). */
export function DeveloperSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="developer-section">
      <ControlPanel />
      <details className="text-[13px]">
        <summary className="cursor-default font-semibold">{DEVELOPER_TEXT.evalCases}</summary>
        <EvalCasesPanel />
      </details>
    </div>
  )
}
