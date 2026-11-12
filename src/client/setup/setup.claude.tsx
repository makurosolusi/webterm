// Wizard step 1, Claude: the staged Test connection of how webterm starts Claude is the step's single
// status. On open it runs without the request stage (opening the wizard spends no tokens); the Claude
// provider card's Test connection runs all four stages, including one real request, in the same view. A failed stage
// carries its fix (install commands, the wrapper's sign-in command) with copy buttons.
import { useEffect, useRef } from 'react'
import { ClaudeProviderCard, type ProviderCommitRef } from '../ClaudeProviderCard'
import { ConnectionTest } from '../claudeLauncher/ConnectionTest'
import { useConnectionTest } from '../claudeLauncher/connectionTest.client'
import { SETUP_TEXT } from './setup.labels'
import { StepFooter, type StepProps } from './setup.ui'

const T = SETUP_TEXT.claude

/** Step 1: Claude Code reachable end to end, and which credential every Claude process uses. */
export function ClaudeStep({ nav }: StepProps): React.JSX.Element {
  const connection = useConnectionTest()
  const commit: ProviderCommitRef = useRef(null)
  const { start } = connection
  useEffect(() => { void start({ request: false }) }, [start])

  return (
    <div className="flex flex-col gap-3" data-setup-step="claude">
      <p className="m-0 text-sm">{T.intro}</p>
      {/* One status surface: this test. The card's Test connection re-runs it instead of showing its own result.
          No separate Save here: Continue saves the card's pending edits first and stays on the step when that fails. */}
      <ConnectionTest test={connection} />
      <ClaudeProviderCard connection={connection} commitRef={commit} />
      <StepFooter nav={nav} where={T.where} at={{ section: 'claude', field: 'claude-provider' }} commit={async () => (commit.current && !(await commit.current()) ? T.saveFailed : null)} />
    </div>
  )
}
