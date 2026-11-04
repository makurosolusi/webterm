// Source Control panel (plan I2-a, ide-parity G2) for one repo root, shown inside the Diff node.
// Imitates Orca's Source Control panel (`review/commit-push.mdx`: stage, Generate with AI, Commit,
// hook output inline + Fix with AI, Push, Create PR) and VS Code's SCM groups. Push is gated by the
// pre-push report (ScmPanel.report.tsx); the server enforces every gate again, the UI only mirrors them.
//
// Collapsed by default and loads nothing until opened, so a Diff node costs no extra request.
import { useCallback, useState } from 'react'
import { Button as VscodeButton } from '@/vscode/register'
import { commitMessageProblem, type ScmArea, type ScmEntry, type ScmHunk, type ScmReport, type ScmStatus } from '../server/gitScm.types'
import { commitStaged, fetchHunks, fetchReport, fetchStatus, generateMessage, ScmApiError, sendFixToAgent, stagePath, unstagePath } from './ScmPanel.api'
import { ScmReportSection } from './ScmPanel.report'
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ScmPanel({ root, agentId, onChanged }: ScmPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<ScmStatus | null>(null)
  const [report, setReport] = useState<ScmReport | null>(null)
  const [msg, setMsg] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
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

  /** Runs one action, then reloads status (and the diff) whatever happened. */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try { await fn(); setMsg(done ?? '') } catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
    await load()
    onChanged?.()
  }

  const toggleHunks = async (path: string, area: 'staged' | 'unstaged') => {
    if (open?.path === path && open.area === area) { setOpen(null); return }
    try { setOpen({ path, area, hunks: await fetchHunks(root, path, area) }) } catch (e) { setMsg(errText(e)) }
  }
  const hunkAction = (h: ScmHunk) => {
    if (!open) return
    const { path, area } = open
    setOpen(null)
    void act(() => (area === 'staged' ? unstagePath(root, path, h.id) : stagePath(root, path, h.id)))
  }

  const problem = commitMessageProblem(message)
  const staged = status?.staged.total ?? 0
  const onGenerate = () => act(async () => {
    const r = await generateMessage(root)
    setMessage(r.message)
    if (r.problem) throw new Error(`Suggested message needs editing: ${r.problem}`)
  })
  const onCommit = () => {
    if (problem || !staged) return
    setFailure(null)
    void act(async () => {
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
            <VscodeButton secondary title="Show hunks" onClick={() => void toggleHunks(e.path, area === 'staged' ? 'staged' : 'unstaged')}>Hunks</VscodeButton>
          )}
          {area === 'staged'
            ? <VscodeButton secondary disabled={busy} aria-label={`Unstage ${e.path}`} onClick={() => void act(() => unstagePath(root, e.path))}>Unstage</VscodeButton>
            : <VscodeButton secondary disabled={busy} aria-label={`Stage ${e.path}`} onClick={() => void act(() => stagePath(root, e.path))}>Stage</VscodeButton>}
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
      <div className="scm-panel__commit">
        <textarea aria-label="Commit message" placeholder="feat(scope): describe the change" value={message} onChange={(e) => setMessage(e.target.value)} />
        {message && problem && <div className="scm-panel__problem" role="alert">{problem}</div>}
        <div className="scm-panel__actions">
          <VscodeButton secondary disabled={busy || !staged} title="Draft a message from the staged changes" onClick={() => void onGenerate()}>Generate with AI</VscodeButton>
          <VscodeButton disabled={busy || !staged || !!problem} onClick={onCommit}>Commit ({staged})</VscodeButton>
        </div>
      </div>
      {failure && (
        <div className="scm-panel__failure">
          <pre aria-label="Commit failure output">{failure.output}</pre>
          <VscodeButton secondary disabled={!agentId} title={agentId ? 'Send the hook output to the wired agent' : 'Wire an agent to this node first'} onClick={onFix}>Fix with agent</VscodeButton>
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
              <VscodeButton secondary disabled={busy} onClick={() => hunkAction(h)}>{open.area === 'staged' ? 'Unstage hunk' : 'Stage hunk'}</VscodeButton>
            </li>
          ))}
        </ul>
      )}
      {status && <ScmReportSection root={root} status={status} report={report} onReport={setReport} onDone={(m) => { setMsg(m); void load() }} />}
    </details>
  )
}
