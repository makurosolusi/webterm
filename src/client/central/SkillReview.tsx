// Skill review: lint result, diff, and the human-only actions. Approve, reject and rollback are one click each; the
// server still requires a human actor (agents get 403), approving activates the draft (R3).
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { useRef, useState } from 'react'
import { CL } from './centralLabels'
import { AudienceBadge } from './SkillAudience'
import './skillDetail.css'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { centralErrorMessage } from './centralLoad'
import { SD } from './skillDetail.labels'
import SkillDiff from './SkillDiff'
import { titleOf } from './skillLibraryModel'

const OPEN_STATUSES: readonly SkillReviewRow['record']['status'][] = ['proposed', 'evaluated', 'pending_approval']

const BUSY = { approve: 'Approving…', reject: 'Rejecting…', rollback: 'Rolling back…' } as const

/** After an action the card is replaced by the reload: move focus to what stays (the card, else its parent). */
function keepFocus(card: HTMLElement | null): void {
  const parent = card?.parentElement ?? null
  queueMicrotask(() => setTimeout(() => {
    const el = card?.isConnected ? card : parent
    if (!el) return
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus()
  }, 0))
}

function LintList({ lint }: { lint: SkillReviewRow['lint'] }) {
  const items: Array<{ pass: boolean; text: string }> = [
    { pass: lint.ok, text: lint.ok ? CL.skillLintOk : CL.skillLintFail },
    ...lint.findings.map((f) => ({ pass: lint.ok, text: f })),
  ]
  return (
    <ul className={`skd-lint skd-lint--${lint.ok ? 'pass' : 'fail'}`} aria-label={SD.lintHeading}>
      {items.map((it, i) => (
        <li key={i} role={i === 0 ? 'status' : undefined}>
          <span className={`codicon codicon-${it.pass ? 'pass' : 'error'}`} aria-hidden="true" />
          {i === 0 && <strong>{it.pass ? SD.lintPass : SD.lintFail}: </strong>}<span>{it.text}</span>
        </li>
      ))}
    </ul>
  )
}

function SkillItem({ row, client, onDone }: { row: SkillReviewRow; client: CentralControlClient; onDone: () => void }) {
  const { record, lint, diff, canRollback } = row
  const card = useRef<HTMLElement>(null)
  // On success the row stays disabled: the status it acted on changed, so the reload remounts it.
  const [done, setDone] = useState(false)
  const failure = (err: unknown) => centralErrorMessage(err, CL.actionFailed)
  const then = (fn: () => Promise<void>) => async () => { await fn(); setDone(true); keepFocus(card.current); onDone() }
  const approve = useAction(then(() => client.approveSkill(record.name, record.version)), { label: CL.skillApprove, failure })
  const reject = useAction(then(() => client.rejectSkill(record.name, record.version)), { label: CL.skillReject, failure })
  const rollback = useAction(then(() => client.rollbackSkill(record.name)), { label: CL.skillRollback, failure })
  const busy = done || approve.busy || reject.busy || rollback.busy
  const named = (verb: string): string => `${verb} ${record.name} ${record.version}`
  const open = OPEN_STATUSES.includes(record.status)
  const blocked = !lint.ok ? SD.approveBlockedLint : null
  const id = `skd-approve-${record.name}-${record.version}`
  return (
    <article ref={card} className="ccp-card" aria-label={`${record.name} ${record.version}`} aria-busy={busy}>
      <header className="skd-head">
        <strong>{titleOf(row)}</strong> {titleOf(row) !== record.name && <code className="skd-slug">{record.name}</code>} <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span> <span className="ccp-badge">{record.origin}</span> <AudienceBadge audience={record.audience} />
        {record.evalScore !== null && <span>{CL.skillScore}: {record.evalScore}</span>}
      </header>
      <p className="skd-note">{SD.reviewSummary(record.name, record.version)}</p>
      <LintList lint={lint} />
      {record.rejectReason && <p className="ccp-error">{CL.skillRejectedBecause(CL.skillRejectReasons[record.rejectReason] ?? record.rejectReason)}</p>}
      {diff && <SkillDiff text={diff} />}
      {record.status === 'pending_approval' && (
        <div className="skd-approval">
          <h5>{SD.approvalHeading}</h5>
          <p className="skd-note">{CL.skillOneClickWhy(record.origin)}</p>
          <div className="skd-approval-actions">
            <ActionButton type="button" size="sm" aria-label={named(CL.skillApprove)} aria-describedby={blocked ? id : undefined} disabled={busy || blocked !== null} action={approve} busyLabel={BUSY.approve}>{SD.approveVisible}</ActionButton>
            {open && <ActionButton type="button" size="sm" variant="secondary" aria-label={named(CL.skillReject)} disabled={busy} action={reject} busyLabel={BUSY.reject}>{SD.rejectVisible}</ActionButton>}
          </div>
          {blocked && !busy && <DisabledReason id={id} reason={blocked} />}
        </div>
      )}
      {open && record.status !== 'pending_approval' && <ActionButton type="button" size="sm" variant="secondary" aria-label={named(CL.skillReject)} disabled={busy} action={reject} busyLabel={BUSY.reject}>{SD.rejectVisible}</ActionButton>}
      {canRollback && <ActionButton type="button" size="sm" variant="secondary" aria-label={named(CL.skillRollback)} disabled={busy} action={rollback} busyLabel={BUSY.rollback}>{SD.rollbackVisible}</ActionButton>}
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
