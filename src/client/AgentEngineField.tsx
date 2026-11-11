// "Engine" row of Central Agent (Settings › Central Agent, Capabilities › Advanced, the Central offer).
// Claude is the only engine (others are retired; on/off is the Central switch), so there is no picker:
// one status line from the REAL launch test Central uses (token-free: --version + auth status), and
// "Check again" = re-detect on the server, then the same test, with busy, result time and failure + Retry.
import { useEffect, useRef, useState } from 'react'
import { ActionButton, ActionResult, errorCause, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { ADVANCED_TEXT } from './advancedLabels'
import { CENTRAL_LAUNCH_TEXT } from './claudeLauncher/CentralLaunchStatus'
import { openLaunchProfileSettings, testClaudeLaunch, type LaunchStep, type LaunchTest } from './claudeLauncher/claudeLaunch.client'
import { CONNECTION_TEXT, CopyLine } from './claudeLauncher/ConnectionTest'
import type { CapabilitiesLoad } from './useCapabilities'

export interface AgentEngineFieldProps {
  /** Reload capabilities with fresh detection; its outcome is reported on the button's result line. */
  redetect(): Promise<CapabilitiesLoad>
  /** False while hidden (a closed Advanced section): the automatic first check waits until shown. */
  active?: boolean
}

/** "claude 2.1.3 (Claude Code)" from the CLI stage, or '' when the probe did not read a version. */
const claudeVersion = (t: LaunchTest): string => {
  const m = t.steps.find((s) => s.stage === 'claude' && s.ok)?.message ?? ''
  return m.startsWith('claude ') && m !== 'claude found' ? m.slice('claude '.length) : ''
}
const failing = (t: LaunchTest): LaunchStep | undefined => t.steps.find((s) => !s.ok)

/** How to fix the failing stage: hint, install commands, sign-in command, and the launch profile link. */
function FixSteps({ step }: { step: LaunchStep | undefined }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 pl-5">
      {step?.hint ? <span className="opacity-70">{step.hint}</span> : null}
      {step?.install ? <>
        <CopyLine label={CONNECTION_TEXT.install} command={step.install.installCommand} />
        <CopyLine label={CONNECTION_TEXT.npm} command={step.install.npmCommand} />
        <a className="underline" href={step.install.docsUrl} target="_blank" rel="noreferrer">{CONNECTION_TEXT.docs}</a>
      </> : null}
      {step?.signIn?.command ? <CopyLine label={CONNECTION_TEXT.signIn} command={step.signIn.command} /> : null}
      <Button size="xs" variant="link" className="self-start px-0" onClick={openLaunchProfileSettings}>{CENTRAL_LAUNCH_TEXT.edit}</Button>
    </div>
  )
}

/** Engine status + Check again. Checks once when first shown (quietly), and again on every press. */
export function AgentEngineField({ redetect, active = true }: AgentEngineFieldProps): React.JSX.Element {
  const [test, setTest] = useState<LaunchTest | null>(null)
  const pressed = useRef(false)
  const action = useAction(async () => {
    if (pressed.current) {
      setTest(null) // a failed redetect must not show the previous test's fix steps
      const r = await redetect()
      if (!r.ok) throw new Error(r.error)
    }
    pressed.current = true // the first (mount) run skips the redetect: the section just loaded fresh data
    const t = await testClaudeLaunch({ central: true })
    if (!Array.isArray(t.steps)) throw new Error('the server sent an unexpected answer') // boundary: never render a partial result
    setTest(t)
    return t
  }, {
    label: ADVANCED_TEXT.engineCheckLabel,
    ok: (t) => t.ok,
    success: (t) => (t.ok ? ADVANCED_TEXT.engineRuns(claudeVersion(t)) : ADVANCED_TEXT.engineCannotStart(failing(t)?.message ?? t.failed ?? '')),
    failure: (e) => ADVANCED_TEXT.engineCheckFailed(errorCause(e)),
  })
  const { run } = action
  const checked = action.result !== null
  useEffect(() => { if (active && !checked) void run({ quiet: true }) }, [run, active, checked])

  return (
    <div className="flex flex-col gap-1 py-2" data-field="agentEngine">
      <span className="text-[13px]">{ADVANCED_TEXT.engineLabel}</span>
      {test?.profile?.name ? <p className="m-0 text-xs opacity-70">{CENTRAL_LAUNCH_TEXT.using(test.profile.name)}</p> : null}
      {action.result ? (
        <ActionResult action={action} stamp={ADVANCED_TEXT.engineStamp}>
          {!action.result.ok ? <FixSteps step={test && !test.ok ? failing(test) : undefined} /> : null}
        </ActionResult>
      ) : <p role="status" className="m-0 text-xs opacity-70">{ADVANCED_TEXT.engineFirstCheck}</p>}
      <IconTooltip label={ADVANCED_TEXT.engineRecheckHint} disabled={action.busy} disabledReason={ADVANCED_TEXT.engineChecking}>
        <ActionButton size="xs" variant="ghost" className="self-start" action={action} busyLabel={ADVANCED_TEXT.engineChecking}>
          {ADVANCED_TEXT.engineRecheck}
        </ActionButton>
      </IconTooltip>
    </div>
  )
}
