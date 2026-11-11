// One health finding: severity, where, evidence, source and suggestion; dismiss needs a reason, reopen undoes it.
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { FindingView } from '../../../shared/centralHealth'
import { relativeTime } from '../../SessionHistory.model'
import { centralErrorMessage } from '../centralLoad'
import type { HealthClient } from './healthApi'
import { DISMISS_PRESETS, DISMISS_REASON_MAX, HL, LEVEL_LABEL, dismissReason, locationOf, needsVerify } from './healthModel'

function CopyLocation({ loc }: { loc: string }) {
  const [copied, setCopied] = useState(false)
  // No Clipboard API outside a secure context: the location stays visible to copy by hand.
  const copy = (): void => {
    navigator.clipboard?.writeText(loc).then(() => setCopied(true), (err: unknown) => console.warn('health: copying the location failed', err))
  }
  return (
    <span className="health-loc">
      <code>{loc}</code>
      <Button type="button" size="xs" variant="ghost" aria-label={HL.copy(loc)} onClick={copy}>{copied ? HL.copied : <span className="codicon codicon-copy" aria-hidden="true" />}</Button>
    </span>
  )
}

function DismissForm({ title, busy, onCancel, onConfirm }: { title: string; busy: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [preset, setPreset] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const reason = dismissReason(preset, note)
  return (
    <div role="group" aria-label={HL.dismissLabel(title)} className="ccp-confirm health-dismiss">
      <p>{HL.dismissPrompt}</p>
      {DISMISS_PRESETS.map((p) => (
        <Button key={p} type="button" size="sm" variant={preset === p ? 'default' : 'secondary'} aria-pressed={preset === p} onClick={() => setPreset(preset === p ? null : p)}>{p}</Button>
      ))}
      <Textarea aria-label={HL.dismissNote} placeholder={HL.dismissNote} maxLength={DISMISS_REASON_MAX} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onCancel}>{HL.cancel}</Button>
      <Button type="button" size="sm" disabled={busy || reason === ''} onClick={() => onConfirm(reason)}>{HL.dismissConfirm}</Button>
    </div>
  )
}

export function HealthFinding({ finding, client }: { finding: FindingView; client: HealthClient }) {
  const [view, setView] = useState(finding)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const act = async (fn: () => Promise<FindingView>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try { setView(await fn()); setAsking(false) } catch (err) { setError(centralErrorMessage(err, HL.actionFailed)) }
    inFlight.current = false
    setBusy(false)
  }
  const loc = locationOf(view)
  const detailsId = `health-details-${view.id}`
  return (
    <li className="health-finding" data-severity={view.severity} data-status={view.status} aria-busy={busy}>
      <div className="health-finding__head">
        <span className="health-chip" data-severity={view.severity}>{LEVEL_LABEL[view.severity]}</span>
        <Button type="button" size="sm" variant="ghost" className="health-finding__title" aria-expanded={open} aria-controls={detailsId} aria-label={HL.details(view.title)} onClick={() => setOpen((o) => !o)}>
          <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />{view.title}
        </Button>
      </div>
      <CopyLocation loc={loc} />
      <p className="health-finding__evidence">{view.evidence}</p>
      <p className="health-finding__meta">
        {view.source} · {HL.confidence(view.confidence)}
        {needsVerify(view.confidence) && <span className="ccp-badge ccp-badge--warn">{HL.verifyFirst}</span>}
        {view.origin === 'analysis' && <span className="ccp-badge" title={HL.verifiedQuoteHint}>{HL.verifiedQuote}</span>}
      </p>
      <p><strong>{HL.suggestion}:</strong> {view.suggestion}</p>
      {view.status === 'dismissed' && view.dismissedReason && <p className="health-finding__meta">{HL.dismissedBecause(view.dismissedReason)}</p>}
      {view.status === 'fixed' && view.fixedAt !== null && <p className="health-finding__meta">{HL.fixedAt(relativeTime(view.fixedAt))}</p>}
      {open && (
        <dl id={detailsId} className="health-finding__details">
          <dt>{HL.evidence}</dt><dd><pre>{view.evidence}</pre></dd>
          <dt>{HL.source}</dt><dd>{view.source}</dd>
          <dd>{HL.seen(relativeTime(view.firstSeenAt), relativeTime(view.lastSeenAt))}</dd>
        </dl>
      )}
      <div className="ccp-row__actions">
        {view.status === 'open' && !asking && <Button type="button" size="sm" variant="secondary" aria-label={HL.dismissLabel(view.title)} disabled={busy} onClick={() => setAsking(true)}>{HL.dismiss}</Button>}
        {view.status === 'dismissed' && <Button type="button" size="sm" variant="secondary" aria-label={HL.reopenLabel(view.title)} disabled={busy} onClick={() => void act(() => client.reopen(view.id))}>{HL.reopen}</Button>}
      </div>
      {asking && <DismissForm title={view.title} busy={busy} onCancel={() => setAsking(false)} onConfirm={(reason) => void act(() => client.dismiss(view.id, reason))} />}
      {error && <p role="alert" className="ccp-error">{error}</p>}
    </li>
  )
}
