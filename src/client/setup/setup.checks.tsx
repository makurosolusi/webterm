// The Claude step's result checklist: the same staged Test connection the Settings card shows
// (`ConnectionTest`), drawn with one icon set in one fixed 16px slot per row, so pass / fail / skipped /
// waiting line up and read the same. Failure fixes (install and sign-in commands) reuse `CopyLine`.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ExternalLink } from '../ExternalLink'
import { CONNECTION_TEXT, CopyLine } from '../claudeLauncher/ConnectionTest'
import { CONN_STAGES, type ConnectionTestHandle, type ConnStage, type StageEvent } from '../claudeLauncher/connectionTest.client'

type RowState = StageEvent['state'] | 'waiting'
const ICON: Record<RowState, string> = {
  running: 'codicon-loading codicon-modifier-spin',
  ok: 'codicon-pass text-(--vscode-testing-iconPassed)',
  failed: 'codicon-error text-(--vscode-errorForeground)',
  skipped: 'codicon-circle-slash text-(--vscode-descriptionForeground)',
  pending: 'codicon-circle-large-outline text-(--vscode-descriptionForeground)',
  waiting: 'codicon-circle-large-outline text-(--vscode-descriptionForeground)',
}

/** One status icon in a fixed slot; every row and the summary line use it. */
function Glyph({ state }: { state: RowState }): React.JSX.Element {
  return <span className={`codicon ${ICON[state]} inline-flex w-4 shrink-0 justify-center text-[16px]`} data-icon={state === 'running' ? 'spinner' : state} aria-hidden="true" />
}

function Row({ stage, e }: { stage: ConnStage; e: StageEvent | undefined }): React.JSX.Element {
  const state: RowState = e?.state ?? 'waiting'
  const quiet = state === 'skipped' || state === 'pending' || state === 'waiting'
  return (
    <li data-stage={stage} data-state={state} className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2">
        <Glyph state={state} />
        <span className={`font-medium${quiet ? ' text-(--vscode-descriptionForeground)' : ''}`}>{CONNECTION_TEXT.stage[stage]}</span>
        {e?.detail && state !== 'running' ? <span className="min-w-0 flex-1 truncate text-(--vscode-descriptionForeground)">{e.detail}</span> : <span className="flex-1" />}
        {state === 'ok' && e?.ms !== undefined ? <span className="shrink-0 tabular-nums text-(--vscode-descriptionForeground)">{CONNECTION_TEXT.duration(e.ms)}</span> : null}
      </div>
      {e?.state === 'failed' ? (
        <div className="flex flex-col gap-1.5 pl-6">
          {e.hint ? <span className="text-(--vscode-descriptionForeground)">{e.hint}</span> : null}
          {e.install ? <>
            <CopyLine label={CONNECTION_TEXT.install} command={e.install.installCommand} />
            <CopyLine label={CONNECTION_TEXT.npm} command={e.install.npmCommand} />
            <ExternalLink className="self-start underline" href={e.install.docsUrl}>{CONNECTION_TEXT.docs}</ExternalLink>
          </> : null}
          {e.signIn?.command ? <CopyLine label={CONNECTION_TEXT.signIn} command={e.signIn.command} /> : null}
        </div>
      ) : null}
    </li>
  )
}

/** Live checklist of one test; nothing before the first run. */
export function SetupChecks({ test }: { test: ConnectionTestHandle }): React.JSX.Element | null {
  const { state: s } = test
  const [, tick] = useState(0)
  useEffect(() => {
    if (!s.running) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [s.running])
  if (!s.running && !s.final && !s.cancelled && !s.error) return null
  const elapsed = s.startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000))
  const summary = 'flex items-start gap-2 m-0'
  return (
    <div className="flex flex-col gap-2 text-xs" data-connection-test={s.running ? 'running' : s.final?.result ?? (s.cancelled ? 'cancelled' : 'error')}>
      {s.error === null ? (
        <ul className="m-0 flex list-none flex-col p-0" aria-label={CONNECTION_TEXT.list} aria-live="polite">
          {CONN_STAGES.map((stage) => <Row key={stage} stage={stage} e={s.stages[stage]} />)}
        </ul>
      ) : null}
      {s.running ? (
        <div className="flex items-center gap-2">
          <p role="status" aria-live="polite" className="m-0 text-(--vscode-descriptionForeground)">{CONNECTION_TEXT.testing(elapsed)}</p>
          <Button size="xs" variant="ghost" onClick={test.cancel}>{CONNECTION_TEXT.cancel}</Button>
        </div>
      ) : null}
      {s.final?.result === 'ok' ? <p role="status" className={summary}><Glyph state="ok" />{s.final.summary}</p> : null}
      {s.final?.result === 'ready' ? <p role="status" className={`${summary} text-(--vscode-descriptionForeground)`}><Glyph state="pending" />{s.final.summary}</p> : null}
      {s.final?.result === 'failed' ? <p role="alert" className={`${summary} text-(--vscode-errorForeground)`}><Glyph state="failed" />{s.final.summary}</p> : null}
      {s.cancelled ? <p role="status" className={`${summary} text-(--vscode-descriptionForeground)`}><Glyph state="skipped" />{CONNECTION_TEXT.cancelled}</p> : null}
      {s.error ? <p role="alert" className={`${summary} text-(--vscode-errorForeground)`}><Glyph state="failed" />{CONNECTION_TEXT.couldNotRun(s.error)}</p> : null}
    </div>
  )
}
