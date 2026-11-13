// Source Control panel (plan I2-a, ide-parity G2) for one repo root, shown inside the Diff node.
// Imitates Orca's Source Control panel (`review/commit-push.mdx`: stage, Generate with AI, Commit,
// hook output inline + Fix with AI, Push, Create PR) and VS Code's SCM groups. Push is gated by the
// pre-push report (ScmPanel.report.tsx); the server enforces every gate again, the UI only mirrors them.
//
// Collapsed by default and loads nothing until opened, so a Diff node costs no extra request.
import { useCallback, useRef, useState } from 'react'
import { Button as VscodeButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import { ActionResult, errorCause, useAction } from '@/components/ui/action'
import { commitMessageProblem, type ScmArea, type ScmEntry, type ScmHunk, type ScmReport, type ScmStatus } from '../server/gitScm.types'
import { commitStaged, fetchHunks, fetchReport, fetchStatus, generateMessage, ScmApiError, sendFixToAgent, stagePath, unstagePath } from './ScmPanel.api'
import { ScmReportSection } from './ScmPanel.report'
import { PrReviewSection } from './prreview/PrReviewSection'
import './ScmPanel.css'

export interface ScmPanelProps {
  root: string
  /** Agent wired to the Diff node: receives "Fix with agent". */
  agentId: string | null
  /** Called after anything that changes the working tree or index, so the diff can refresh. */
  onChanged?: () => void
}

const GROUPS: { area: ScmArea; label: string }[] = [
  { area: 'staged', label: 'Staged Changes' },
  { area: 'unstaged', label: 'Changes' },
  { area: 'untracked', label: 'Untracked' },
]

interface Failure { output: string; fixPrompt: string; attempt: string }
type OpKind = 'stage' | 'generate' | 'commit'
interface Op { kind: OpKind; fn: () => Promise<unknown>; done: string }
const BUSY_TEXT = { generate: 'Generating…', commit: 'Committing…' }
const busyOn = (on: boolean): 'true' | 'false' => (on ? 'true' : 'false')

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ScmPanel({ root, agentId, onChanged }: ScmPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<ScmStatus | null>(null)
  const [report, setReport] = useState<ScmReport | null>(null)
  const [msg, setMsg] = useState('')
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [open, setOpen] = useState<{ path: string; area: 'staged' | 'unstaged'; hunks: ScmHunk[] } | null>(null)

  const load = useCallback(async () => {
    try { setStatus(await fetchStatus(root)) } catch (e) { setMsg(errText(e)) }
  }, [root])
  /** On open: status plus the server's latest report (it outlives a page reload, not a server restart). */
  const loadAll = () => {
    void load()
    fetchReport(root).then(setReport, (e) => setMsg(errText(e)))
  }

  // One operation at a time (they all touch the index): busy while it runs, then its result line,
  // or the failure with Retry (which runs that same operation again). Status (and the diff) reload either way.
  const pending = useRef<Op | null>(null)
  const op = useAction(async () => {
    const p = pending.current!
    try { await p.fn() } finally { await load(); onChanged?.() }
    return p.done
  }, { label: 'Source control', success: (done) => done, failure: errorCause })
  const busy = op.busy
  const running = (kind: OpKind): boolean => busy && pending.current?.kind === kind
  const act = (kind: OpKind, fn: () => Promise<unknown>, done: string): void => {
    if (busy) return
    pending.current = { kind, fn, done }
    void op.run()
  }

  const hunkReq = useRef<{ path: string; area: 'staged' | 'unstaged' }>({ path: '', area: 'unstaged' })
  const hunks = useAction(async () => {
    const { path, area } = hunkReq.current
    setOpen({ path, area, hunks: await fetchHunks(root, path, area) })
  }, { label: 'Show hunks', success: () => 'Hunks shown', failure: errorCause })
  const toggleHunks = (path: string, area: 'staged' | 'unstaged'): void => {
    if (open?.path === path && open.area === area) { setOpen(null); return }
    hunkReq.current = { path, area }
    void hunks.run()
  }
  const hunkAction = (h: ScmHunk) => {
    if (!open) return
    const { path, area } = open
    setOpen(null)
    act('stage', () => (area === 'staged' ? unstagePath(root, path, h.id) : stagePath(root, path, h.id)), area === 'staged' ? 'Hunk unstaged.' : 'Hunk staged.')
  }

  const problem = commitMessageProblem(message)
  const staged = status?.staged.total ?? 0
  const onGenerate = (): void => act('generate', async () => {
    const r = await generateMessage(root)
    setMessage(r.message)
    if (r.problem) throw new Error(`Suggested message needs editing: ${r.problem}`)
  }, 'Message drafted.')
  const onCommit = () => {
    if (problem || !staged) return
    setFailure(null)
    act('commit', async () => {
      try {
        await commitStaged(root, message)
        setMessage('')
        setReport(null) // HEAD moved: the old report no longer applies
      } catch (e) {
        if (e instanceof ScmApiError && e.body.error === 'commit_failed') {
          setFailure({ output: String(e.body.output ?? ''), fixPrompt: String(e.body.fixPrompt ?? ''), attempt: String(Date.now()) })
        }
        throw e
      }
    }, 'Committed.')
  }
  const onFix = () => {
    if (!failure || !agentId) return
    void sendFixToAgent(agentId, failure.fixPrompt, failure.attempt)
      .then(() => setMsg('Sent the hook output to the agent; it gets it as soon as its prompt is free.'), (e) => setMsg(errText(e)))
  }

  const row = (e: ScmEntry, area: ScmArea) => (
    <li key={`${area}:${e.path}`} className="scm-panel__row">
      <span className="scm-panel__code">{e.code}</span>
      <span className="scm-panel__path" title={e.oldPath ? `${e.oldPath} → ${e.path}` : e.path}>{e.path}</span>
      {e.sensitive && area !== 'staged' ? (
        <span className="scm-panel__refused" role="note">
          <span className="codicon codicon-lock" aria-hidden="true" /> Secret file (matches {e.sensitivePattern}); never staged
        </span>
      ) : (
        <>
          {area !== 'untracked' && !e.sensitive && (
            <IconTooltip label="Show hunks">
              <VscodeButton secondary disabled={hunks.busy} aria-busy={busyOn(hunks.busy)} onClick={() => toggleHunks(e.path, area === 'staged' ? 'staged' : 'unstaged')}>Hunks</VscodeButton>
            </IconTooltip>
          )}
          {area === 'staged'
            ? <VscodeButton secondary disabled={busy} aria-busy={busyOn(busy)} aria-label={`Unstage ${e.path}`} onClick={() => act('stage', () => unstagePath(root, e.path), `Unstaged ${e.path}.`)}>Unstage</VscodeButton>
            : <VscodeButton secondary disabled={busy} aria-busy={busyOn(busy)} aria-label={`Stage ${e.path}`} onClick={() => act('stage', () => stagePath(root, e.path), `Staged ${e.path}.`)}>Stage</VscodeButton>}
        </>
      )}
    </li>
  )

  return (
    <details className="scm-panel nodrag nowheel nokey" onToggle={(ev) => { if ((ev.currentTarget as HTMLDetailsElement).open) loadAll() }}>
      <summary>
        <span className="codicon codicon-source-control" aria-hidden="true" /> Source Control
        {status && <span className="scm-panel__branch"> {status.branch ?? '(detached)'}{status.upstream ? ` ↑${status.ahead} ↓${status.behind}` : ' (not published)'}</span>}
      </summary>
      {msg && <div className="scm-panel__msg" role="status">{msg}</div>}
      {(op.result || hunks.result) && <div className="scm-panel__msg"><ActionResult action={op} /><ActionResult action={hunks} /></div>}
      <div className="scm-panel__commit">
        <textarea aria-label="Commit message" placeholder="feat(scope): describe the change" value={message} onChange={(e) => setMessage(e.target.value)} />
        {message && problem && <div className="scm-panel__problem" role="alert">{problem}</div>}
        <div className="scm-panel__actions">
          <IconTooltip label="Draft a message from the staged changes">
            <VscodeButton secondary disabled={busy || !staged} aria-busy={busyOn(running('generate'))} onClick={onGenerate}>{running('generate') ? BUSY_TEXT.generate : 'Generate with AI'}</VscodeButton>
          </IconTooltip>
          <VscodeButton disabled={busy || !staged || !!problem} aria-busy={busyOn(running('commit'))} onClick={onCommit}>{running('commit') ? BUSY_TEXT.commit : `Commit (${staged})`}</VscodeButton>
        </div>
      </div>
      {failure && (
        <div className="scm-panel__failure">
          <pre aria-label="Commit failure output">{failure.output}</pre>
          <IconTooltip label={agentId ? 'Send the hook output to the wired agent' : 'Wire an agent to this node first'}>
            <VscodeButton secondary disabled={!agentId} onClick={onFix}>Fix with agent</VscodeButton>
          </IconTooltip>
        </div>
      )}
      {status && GROUPS.map(({ area, label }) => status[area].total > 0 && (
        <section key={area} aria-label={label}>
          <h4 className="scm-panel__group">{label} ({status[area].total})</h4>
          <ul className="scm-panel__list">{status[area].entries.map((e) => row(e, area))}</ul>
        </section>
      ))}
      {open && (
        <ul className="scm-panel__hunks" aria-label={`Hunks of ${open.path}`}>
          {open.hunks.map((h) => (
            <li key={h.id}>
              <pre>{h.text}</pre>
              <VscodeButton secondary disabled={busy} aria-busy={busyOn(busy)} onClick={() => hunkAction(h)}>{open.area === 'staged' ? 'Unstage hunk' : 'Stage hunk'}</VscodeButton>
            </li>
          ))}
        </ul>
      )}
      {status && <ScmReportSection root={root} status={status} report={report} onReport={setReport} onDone={(m) => { setMsg(m); void load() }} />}
      {status && <PrReviewSection root={root} gh={status.gh} />}
    </details>
  )
}
