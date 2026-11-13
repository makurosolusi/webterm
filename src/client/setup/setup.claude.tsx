// Wizard step 1, Claude. Order: the choice (the Claude provider card: how every Claude process signs
// in), then its action (the card's Test connection), then the result checklist under it. On open the
// test runs without the request stage (opening the wizard spends no tokens); the card's Test
// connection runs all four stages, including one real request. Continue never waits for a passing
// test: the footer only says the connection can be tested or fixed later.
import { useEffect, useRef } from 'react'
import { ClaudeProviderCard, type ProviderCommitRef } from '../ClaudeProviderCard'
import { useConnectionTest, type ConnectionTestState } from '../claudeLauncher/connectionTest.client'
import { SetupChecks } from './setup.checks'
import { SETUP_TEXT } from './setup.labels'
import { StepFooter, StepPage, type StepProps, type StepSetting } from './setup.ui'

const T = SETUP_TEXT.claude
const SETTING: StepSetting = { where: T.where, section: 'claude', field: 'claude-provider' }

/** The footer line for a test that has not passed with a real request; null once it has (or while it runs). */
export function claudeNotice(s: ConnectionTestState): string | null {
  if (s.running || s.final?.result === 'ok') return null
  return s.final?.result === 'failed' || s.error ? T.failed : T.untested
}

/** Step 1: Claude Code reachable end to end, and which credential every Claude process uses. */
export function ClaudeStep({ nav }: StepProps): React.JSX.Element {
  const connection = useConnectionTest()
  const commit: ProviderCommitRef = useRef(null)
  const { start } = connection
  useEffect(() => { void start({ request: false }) }, [start])

  // One status surface: this checklist. The card's Test connection re-runs it instead of showing its own result.
  // No separate Save here: Continue saves the card's pending edits first and stays on the step when that fails.
  const footer = <StepFooter nav={nav} notice={claudeNotice(connection.state) ?? undefined}
    commit={async () => (commit.current && !(await commit.current()) ? T.saveFailed : null)} />
  return (
    <StepPage step="claude" setting={SETTING} footer={footer}>
      <ClaudeProviderCard connection={connection} commitRef={commit} />
      <SetupChecks test={connection} />
    </StepPage>
  )
}
