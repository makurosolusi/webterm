// Central Agent card: which Claude launch profile Central uses and exactly which stage fails
// (wrapper missing, wrapper error, claude missing, not signed in), with a link to fix the profile.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { openLaunchProfileSettings, testClaudeLaunch, type LaunchTest } from './claudeLaunch.client'
import { LaunchSteps } from './LaunchSteps'

export const CENTRAL_LAUNCH_TEXT = {
  checking: 'Checking how Central starts Claude…',
  using: (name: string): string => `Launch profile: ${name}`,
  edit: 'Edit launch profile',
  failed: 'Could not check the launch profile.',
}

/** `version` changes = run the check again (the parent's "Check again"). */
export function CentralLaunchStatus({ version = 0 }: { version?: number }): React.JSX.Element {
  const [result, setResult] = useState<LaunchTest | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    setResult(null)
    setError(false)
    testClaudeLaunch({ central: true })
      .then((r) => { if (live) setResult(r) })
      .catch(() => { if (live) setError(true) }) // the code is not actionable here; the link still is
    return () => { live = false }
  }, [version])
  return (
    <div className="flex flex-col gap-1 text-xs" data-central-launch>
      {result ? <p className="m-0 opacity-70">{CENTRAL_LAUNCH_TEXT.using(result.profile.name)}</p> : null}
      {result ? <LaunchSteps steps={result.steps} />
        : <p role="status" className="m-0 opacity-70">{error ? CENTRAL_LAUNCH_TEXT.failed : CENTRAL_LAUNCH_TEXT.checking}</p>}
      <Button size="xs" variant="link" className="self-start px-0" onClick={openLaunchProfileSettings}>{CENTRAL_LAUNCH_TEXT.edit}</Button>
    </div>
  )
}
