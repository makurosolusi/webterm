// Skill review: lint result, diff, and the human-only actions. Approving activates a skill (R3), so it
// needs the typed phrase; reject and rollback are one click (reject only frees the name, rollback re-points `active/<name>`).
import { Input } from '@/components/ui/input'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { useState } from 'react'
import { CONFIRM_PHRASE } from '../../shared/approvalConfirm'
import { CL } from './centralLabels'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { centralErrorMessage } from './centralLoad'

const OPEN_STATUSES: readonly SkillReviewRow['record']['status'][] = ['proposed', 'evaluated', 'pending_approval']

const BUSY = { approve: 'Approving…', reject: 'Rejecting…', rollback: 'Rolling back…' } as const

const diffClass = (line: string): string => (line.startsWith('+') ? 'ccp-diff--add' : line.startsWith('-') ? 'ccp-diff--del' : '')

function SkillItem({ row, client, onDone }: { row: SkillReviewRow; client: CentralControlClient; onDone: () => void }) {
  const { record, lint, diff, canRollback } = row
  const [typed, setTyped] = useState('')
  // On success the row stays disabled: the status it acted on changed, so the reload remounts it.
  const [done, setDone] = useState(false)
  const failure = (err: unknown) => centralErrorMessage(err, CL.actionFailed)
  const then = (fn: () => Promise<void>) => async () => { await fn(); setDone(true); onDone() }
  const approve = useAction(then(() => client.approveSkill(record.name, record.version, typed)), { label: CL.skillApprove, failure })
  const reject = useAction(then(() => client.rejectSkill(record.name, record.version)), { label: CL.skillReject, failure })
  const rollback = useAction(then(() => client.rollbackSkill(record.name)), { label: CL.skillRollback, failure })
  const busy = done || approve.busy || reject.busy || rollback.busy
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
          <ActionButton type="button" size="sm" aria-label={named(CL.skillApprove)} disabled={busy || typed !== CONFIRM_PHRASE || !lint.ok} action={approve} busyLabel={BUSY.approve}>{CL.skillApprove}</ActionButton>
        </>
      )}
      {open && <ActionButton type="button" size="sm" variant="secondary" aria-label={named(CL.skillReject)} disabled={busy} action={reject} busyLabel={BUSY.reject}>{CL.skillReject}</ActionButton>}
      {canRollback && <ActionButton type="button" size="sm" variant="secondary" aria-label={named(CL.skillRollback)} disabled={busy} action={rollback} busyLabel={BUSY.rollback}>{CL.skillRollback}</ActionButton>}
      <ActionResult action={approve} />
      <ActionResult action={reject} />
      <ActionResult action={rollback} />
    </article>
  )
}

/** Review actions for the given rows (approve, reject, rollback); the parent owns loading and reload. */
export default function SkillReviewList({ rows, client, onDone }: { rows: readonly SkillReviewRow[]; client: CentralControlClient; onDone: () => void }) {
  return <>{rows.map((r) => <SkillItem key={`${r.record.name}@${r.record.version}:${r.record.status}`} row={r} client={client} onDone={onDone} />)}</>
}
