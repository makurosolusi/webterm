// Wizard step 1, Claude: a live check of how webterm starts Claude (the profile Central uses) and
// the existing Claude provider card for the credential. Claude missing = the official install
// commands with copy buttons, the docs link and "Check again".
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ClaudeProviderCard } from '../ClaudeProviderCard'
import { testClaudeLaunch, type LaunchTest } from '../claudeLauncher/claudeLaunch.client'
import { LaunchSteps } from '../claudeLauncher/LaunchSteps'
import { SETUP_TEXT } from './setup.labels'
import { StepFooter, type StepProps } from './setup.ui'

const T = SETUP_TEXT.claude

/** What the probe says, as one of the states the step shows. */
export type ClaudeCheck = 'checking' | 'ready' | 'notFound' | 'notSignedIn' | 'wrapperFailed' | 'checkFailed'

/** Map a launch test (or its absence after an error) to the step's state. */
export function claudeCheckState(r: LaunchTest | null, error: boolean): ClaudeCheck {
  if (error) return 'checkFailed'
  if (!r) return 'checking'
  if (r.ok) return 'ready'
  if (r.failed === 'claude_not_found') return 'notFound'
  if (r.failed === 'auth_failed') return 'notSignedIn'
  if (r.failed === 'wrapper_not_found' || r.failed === 'wrapper_failed') return 'wrapperFailed'
  return 'checkFailed'
}

function CopyLine({ label, command }: { label: string; command: string }): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const copy = (): void => {
    const write = navigator.clipboard?.writeText(command) ?? Promise.reject(new Error('clipboard unavailable'))
    write.then(() => setNote(T.copied), (e: unknown) => {
      console.warn('setup: copy install command failed', e instanceof Error ? e.name : 'error')
      setNote(T.copyFailed)
    })
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs opacity-70">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-xs">{command}</code>
        <Button size="sm" variant="outline" aria-label={`${T.copy}: ${label}`} onClick={copy}>{T.copy}</Button>
      </div>
      {note ? <span role="status" className="text-xs opacity-70">{note}</span> : null}
    </div>
  )
}

/** Step 1: Claude Code installed and signed in, and which credential every Claude process uses. */
export function ClaudeStep({ nav }: StepProps): React.JSX.Element {
  const [result, setResult] = useState<LaunchTest | null>(null)
  const [error, setError] = useState(false)
  const [run, setRun] = useState(0)
  useEffect(() => {
    let live = true
    setResult(null)
    setError(false)
    testClaudeLaunch({ central: true }).then(
      (r) => { if (live) setResult(r) },
      (e: unknown) => {
        console.warn('setup: claude launch check failed', e instanceof Error ? e.message : 'error')
        if (live) setError(true)
      },
    )
    return () => { live = false }
  }, [run])
  const state = claudeCheckState(result, error)
  const install = result?.steps.find((s) => s.install)?.install
  const again = <Button size="sm" variant="outline" className="self-start" onClick={() => setRun((n) => n + 1)}>{state === 'checkFailed' ? SETUP_TEXT.retry : T.checkAgain}</Button>

  return (
    <div className="flex flex-col gap-3" data-setup-step="claude">
      <p className="m-0 text-sm">{T.intro}</p>
      <div className="flex flex-col gap-1.5" data-claude-check={state}>
        <p role="status" className={`m-0 text-xs ${state === 'ready' ? '' : state === 'checking' ? 'opacity-70' : 'text-destructive'}`}>
          {T[state]}
        </p>
        {result ? <LaunchSteps steps={result.steps} /> : null}
        {state === 'notFound' && install ? (
          <div className="flex flex-col gap-2">
            <CopyLine label={T.install} command={install.installCommand} />
            <CopyLine label={T.npm} command={install.npmCommand} />
            <a className="text-xs underline" href={install.docsUrl} target="_blank" rel="noreferrer">{T.docs}</a>
          </div>
        ) : null}
        {state !== 'checking' && state !== 'ready' ? again : null}
      </div>
      <ClaudeProviderCard />
      <StepFooter nav={nav} where={T.where} />
    </div>
  )
}
