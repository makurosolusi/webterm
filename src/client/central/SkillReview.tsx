// Skill review: lint result, diff, and the human-only actions. Approving activates a skill (R3), so it
// needs the typed phrase; reject and rollback are one click (reject only frees the name, rollback re-points `active/<name>`).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRef, useState } from 'react'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { useCapabilities } from '../useCapabilities'
import { CL } from './centralLabels'
import { CENTRAL_SKILLS_SUB, SKILLS_OFF, centralControlApi } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { centralErrorMessage, useLoad } from './centralLoad'

const OPEN_STATUSES: readonly SkillReviewRow['record']['status'][] = ['proposed', 'evaluated', 'pending_approval']

const diffClass = (line: string): string => (line.startsWith('+') ? 'ccp-diff--add' : line.startsWith('-') ? 'ccp-diff--del' : '')

function SkillItem({ row, client, onDone }: { row: SkillReviewRow; client: CentralControlClient; onDone: () => void }) {
  const { record, lint, diff, canRollback } = row
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const act = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    // On success the row stays busy: the status it acted on changed, so the reload remounts it.
    try { await fn(); onDone() } catch (err) { inFlight.current = false; setBusy(false); setError(centralErrorMessage(err, CL.actionFailed)) }
  }
  const named = (verb: string): string => `${verb} ${record.name} ${record.version}`
  const open = OPEN_STATUSES.includes(record.status)
  return (
    <article className="ccp-card" aria-label={`${record.name} ${record.version}`} aria-busy={busy}>
      <header>
        <strong>{record.name}</strong> <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span> <span className="ccp-badge">{record.origin}</span>
        {record.evalScore !== null && <span>{CL.skillScore}: {record.evalScore}</span>}
      </header>
      <p className={lint.ok ? 'ccp-ok' : 'ccp-error'} role="status">{lint.ok ? CL.skillLintOk : CL.skillLintFail}</p>
      {record.rejectReason && <p className="ccp-error">{CL.skillRejectedBecause(record.rejectReason)}</p>}
      {lint.findings.length > 0 && <ul aria-label={CL.skillLint}>{lint.findings.map((f) => <li key={f}>{f}</li>)}</ul>}
      {diff && (
        <pre className="ccp-diff" tabIndex={0} aria-label={CL.skillDiff}>
          {diff.split('\n').map((l, i) => <span key={i} className={diffClass(l)}>{l}{'\n'}</span>)}
        </pre>
      )}
      {record.status === 'pending_approval' && (
        <>
          <label className="ccp-confirm-input">{CL.confirmLabel(CONFIRM_PHRASE)}
            <Input value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </label>
          <Button type="button" size="sm" aria-label={named(CL.skillApprove)} disabled={busy || typed !== CONFIRM_PHRASE || !lint.ok} onClick={() => void act(() => client.approveSkill(record.name, record.version, typed))}>{CL.skillApprove}</Button>
        </>
      )}
      {open && <Button type="button" size="sm" variant="secondary" aria-label={named(CL.skillReject)} disabled={busy} onClick={() => void act(() => client.rejectSkill(record.name, record.version))}>{CL.skillReject}</Button>}
      {canRollback && <Button type="button" size="sm" variant="secondary" aria-label={named(CL.skillRollback)} disabled={busy} onClick={() => void act(() => client.rollbackSkill(record.name))}>{CL.skillRollback}</Button>}
      {error && <p role="alert" className="ccp-error">{error}</p>}
    </article>
  )
}

/** Skills switched off: what they do and the Central card's skills switch (applies live, no restart). */
function SkillsOff({ onEnabled }: { onEnabled: () => void }) {
  const { busyId, error, setSub } = useCapabilities()
  const enable = async () => { if (await setSub('central', CENTRAL_SKILLS_SUB, true)) onEnabled() }
  return (
    <div className="ccp-off" data-central-off="skills">
      <p>{CL.skillsOff}</p>
      <Button type="button" size="sm" disabled={busyId === 'central'} onClick={() => void enable()}>{CL.turnOn}</Button>
      {error && <p role="alert" className="ccp-error">{error}</p>}
    </div>
  )
}

export default function SkillReview({ client = centralControlApi }: { client?: CentralControlClient }) {
  const list = useLoad((s) => client.listSkills(s))
  const off = list.code === SKILLS_OFF
  return (
    <section className="ccp-section" aria-labelledby="ccp-skills-h">
      <h3 id="ccp-skills-h">{CL.skillsHeading}</h3>
      {off && <SkillsOff onEnabled={list.reload} />}
      {list.error && !off && <p role="alert" className="ccp-error">{list.error}</p>}
      {list.loading && !list.data && <p role="status">{CL.loading}</p>}
      {list.data?.length === 0 && <p>{CL.empty}</p>}
      {list.data?.map((r) => <SkillItem key={`${r.record.name}@${r.record.version}:${r.record.status}`} row={r} client={client} onDone={list.reload} />)}
    </section>
  )
}
