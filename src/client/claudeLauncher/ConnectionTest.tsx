// Test connection progress, like a CI step list: one row per stage (spinner while running, check with
// detail and duration, cross with reason, fix hint and copyable commands, dash when skipped), a
// "Testing… N s" header with Cancel, and a final banner (status on success, alert on failure).
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CONN_STAGES, type ConnectionTestHandle, type ConnectionTestState, type ConnStage, type StageEvent } from './connectionTest.client'

export const CONNECTION_TEXT = {
  stage: { wrapper: 'Wrapper', cli: 'Claude CLI', auth: 'Sign-in', request: 'Request' } as Record<ConnStage, string>,
  list: 'Connection test',
  testing: (s: number): string => `Testing… ${s} s`,
  cancel: 'Cancel',
  cancelled: 'Test cancelled.',
  couldNotRun: (code: string): string => `Could not run the test (${code}). Try again.`,
  waiting: 'waiting',
  duration: (ms: number): string => `${(ms / 1000).toFixed(1)} s`,
  button: { idle: 'Test connection', running: 'Testing…', again: 'Test again' },
  install: 'Install command',
  npm: 'Or with npm (Node.js 22 or newer)',
  docs: 'Install guide',
  signIn: 'Sign-in command (fill in your own values)',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy. Select the command and copy it by hand.',
}

/** Test connection → Testing… → Test again (a check without the request still offers "Test connection"). */
export const testButtonLabel = (s: ConnectionTestState): string =>
  s.running ? CONNECTION_TEXT.button.running
    : (s.final && s.final.result !== 'ready') || s.cancelled || s.error ? CONNECTION_TEXT.button.again : CONNECTION_TEXT.button.idle

export function CopyLine({ label, command }: { label: string; command: string }): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const copy = (): void => {
    const write = navigator.clipboard?.writeText(command) ?? Promise.reject(new Error('clipboard unavailable'))
    write.then(() => setNote(CONNECTION_TEXT.copied), (e: unknown) => {
      console.warn('connection test: copy command failed', e instanceof Error ? e.name : 'error')
      setNote(CONNECTION_TEXT.copyFailed)
    })
  }
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs opacity-70">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-xs">{command}</code>
        <Button size="sm" variant="outline" aria-label={`${CONNECTION_TEXT.copy}: ${label}`} onClick={copy}>{CONNECTION_TEXT.copy}</Button>
      </div>
      {note ? <span role="status" className="text-xs opacity-70">{note}</span> : null}
    </div>
  )
}

const ICON: Record<StageEvent['state'], React.JSX.Element> = {
  running: <span className="codicon codicon-loading codicon-modifier-spin" data-icon="spinner" aria-hidden="true" />,
  ok: <span className="codicon codicon-pass text-(--vscode-testing-iconPassed)" data-icon="ok" aria-hidden="true" />,
  failed: <span className="codicon codicon-error text-destructive" data-icon="failed" aria-hidden="true" />,
  skipped: <span className="opacity-50" data-icon="skipped" aria-hidden="true">—</span>,
  pending: <span className="codicon codicon-circle-large-outline opacity-60" data-icon="pending" aria-hidden="true" />,
}

function Row({ stage, e }: { stage: ConnStage; e: StageEvent | undefined }): React.JSX.Element {
  return (
    <li data-stage={stage} data-state={e?.state ?? 'waiting'} className={e && e.state !== 'skipped' && e.state !== 'pending' ? '' : 'opacity-60'}>
      {e ? ICON[e.state] : <span className="codicon codicon-circle-large-outline opacity-50" data-icon="waiting" aria-hidden="true" />}{' '}
      <span className="font-medium">{CONNECTION_TEXT.stage[stage]}</span>
      {e?.state === 'running' ? '…' : e?.detail ? `: ${e.detail}` : e ? null : ` (${CONNECTION_TEXT.waiting})`}
      {e?.state === 'ok' && e.ms !== undefined ? <span className="opacity-60"> · {CONNECTION_TEXT.duration(e.ms)}</span> : null}
      {e?.state === 'failed' ? (
        <div className="flex flex-col gap-1.5 pl-5 pt-0.5">
          {e.hint ? <span className="opacity-70">{e.hint}</span> : null}
          {e.install ? <>
            <CopyLine label={CONNECTION_TEXT.install} command={e.install.installCommand} />
            <CopyLine label={CONNECTION_TEXT.npm} command={e.install.npmCommand} />
            <a className="underline" href={e.install.docsUrl} target="_blank" rel="noreferrer">{CONNECTION_TEXT.docs}</a>
          </> : null}
          {e.signIn?.command ? <CopyLine label={CONNECTION_TEXT.signIn} command={e.signIn.command} /> : null}
        </div>
      ) : null}
    </li>
  )
}

/** The live view of one test (`test` from useConnectionTest); renders nothing before the first run. */
export function ConnectionTest({ test }: { test: ConnectionTestHandle }): React.JSX.Element | null {
  const { state: s } = test
  const [, tick] = useState(0)
  useEffect(() => {
    if (!s.running) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [s.running])
  if (!s.running && !s.final && !s.cancelled && !s.error) return null
  const elapsed = s.startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000))
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-connection-test={s.running ? 'running' : s.final?.result ?? (s.cancelled ? 'cancelled' : 'error')}>
      {s.running ? (
        <div className="flex items-center gap-2">
          <p role="status" aria-live="polite" className="m-0 opacity-80">{CONNECTION_TEXT.testing(elapsed)}</p>
          <Button size="sm" variant="outline" onClick={test.cancel}>{CONNECTION_TEXT.cancel}</Button>
        </div>
      ) : null}
      {s.error === null ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={CONNECTION_TEXT.list} aria-live="polite">
          {CONN_STAGES.map((stage) => <Row key={stage} stage={stage} e={s.stages[stage]} />)}
        </ul>
      ) : null}
      {s.final?.result === 'ok' ? <p role="status" className="m-0"><span className="codicon codicon-pass" aria-hidden="true" /> {s.final.summary}</p> : null}
      {s.final?.result === 'ready' ? <p role="status" className="m-0 opacity-80"><span className="codicon codicon-info" aria-hidden="true" /> {s.final.summary}</p> : null}
      {s.final?.result === 'failed' ? <p role="alert" className="m-0 text-destructive"><span className="codicon codicon-error" aria-hidden="true" /> {s.final.summary}</p> : null}
      {s.cancelled ? <p role="status" className="m-0 opacity-70">{CONNECTION_TEXT.cancelled}</p> : null}
      {s.error ? <p role="alert" className="m-0 text-destructive">{CONNECTION_TEXT.couldNotRun(s.error)}</p> : null}
    </div>
  )
}
