// Pre-push report + Push + Create PR of the Source Control panel. Push stays disabled until a report
// exists that is green, or red with failures the user explicitly acknowledged; credential findings
// can never be acknowledged (Rule 7). The server checks all of this again (gitScm.report.ts push()).
import { useState } from 'react'
import { Button as VscodeButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import type { ScmReport, ScmStatus } from '../server/gitScm.types'
import { createPr, pushBranch, runReport } from './ScmPanel.api'

export interface ScmReportSectionProps {
  root: string
  status: ScmStatus
  report: ScmReport | null
  onReport: (r: ScmReport) => void
  onDone: (message: string) => void
}

const STATUS_ICON: Record<string, string> = { pass: 'pass', fail: 'error', timeout: 'watch', skipped: 'circle-slash' }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Push is allowed by the UI exactly when the server would allow it (minus the HEAD freshness check). */
export function pushAllowed(report: ScmReport | null, acknowledged: boolean): boolean {
  return !!report && report.credentials.length === 0 && (report.green || acknowledged)
}

export function ScmReportSection({ root, status, report, onReport, onDone }: ScmReportSectionProps): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [ack, setAck] = useState(false)
  const busy = (fn: () => Promise<string>) => {
    setRunning(true)
    fn().then(onDone, (e) => onDone(errText(e))).finally(() => setRunning(false))
  }

  const onRun = () => busy(async () => {
    setAck(false)
    const r = await runReport(root)
    onReport(r)
    return r.green ? 'Pre-push checks are green.' : 'Pre-push checks found problems.'
  })
  const onPush = () => {
    if (!pushAllowed(report, ack)) return
    busy(async () => { await pushBranch(root, ack); return 'Pushed.' })
  }
  const onPr = () => busy(async () => `Pull request: ${(await createPr(root)).url}`)

  return (
    <section className="scm-panel__report" aria-label="Pre-push report">
      <div className="scm-panel__actions">
        <IconTooltip label="Run test, typecheck and lint, and scan the outgoing diff">
          <VscodeButton secondary disabled={running} onClick={onRun}>
            {running ? 'Running…' : 'Run pre-push checks'}
          </VscodeButton>
        </IconTooltip>
        <IconTooltip label={report ? 'Push the branch to its remote' : 'Run the pre-push checks first'}>
          <VscodeButton disabled={running || !pushAllowed(report, ack)} onClick={onPush}>Push</VscodeButton>
        </IconTooltip>
        {status.gh && (
          <IconTooltip label="gh pr create --fill">
            <VscodeButton secondary disabled={running || !status.upstream || status.ahead !== 0} onClick={onPr}>Create PR</VscodeButton>
          </IconTooltip>
        )}
      </div>
      {report && (
        <>
          <ul className="scm-panel__checks" aria-label="Checks">
            {report.checks.map((c) => (
              <li key={c.name} data-status={c.status}>
                <span className={`codicon codicon-${STATUS_ICON[c.status]}`} aria-hidden="true" /> {c.name}: {c.status} <span className="scm-panel__detail">{c.detail}</span>
                {c.output && c.status !== 'pass' && <details><summary>Output</summary><pre>{c.output}</pre></details>}
              </li>
            ))}
          </ul>
          {report.credentials.length > 0 && (
            <div role="alert" className="scm-panel__problem">
              Credentials in the outgoing diff (push blocked; remove them and rotate if ever pushed):
              <ul>{report.credentials.map((f) => <li key={`${f.path}:${f.line}`}>{f.path}:{f.line} {f.text}</li>)}</ul>
            </div>
          )}
          {report.debt.length > 0 && (
            <details className="scm-panel__debt"><summary>Technical debt in added lines ({report.debt.length})</summary>
              <ul>{report.debt.map((f) => <li key={`${f.path}:${f.line}`}>{f.path}:{f.line} {f.text}</li>)}</ul>
            </details>
          )}
          {!report.green && report.credentials.length === 0 && (
            <label className="scm-panel__ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I acknowledge the failed checks and want to push anyway
            </label>
          )}
        </>
      )}
    </section>
  )
}
