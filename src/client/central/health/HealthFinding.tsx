// Health findings as Problems-panel rows: one line (severity, message, file), details on expand, actions on
// hover/focus. Findings of one kind collapse into a group row with a count; dismiss needs a reason, reopen undoes it.
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton, IconTooltip } from '@/components/ui/icon-button'
import { Textarea } from '@/components/ui/textarea'
import { ActionButton, ActionResult, useAction, type Action } from '@/components/ui/action'
import type { FindingView } from '../../../shared/centralHealth'
import { relativeTime } from '../../SessionHistory.model'
import { lspFileOpener } from '../../editorLsp.store'
import { draftCentralChat } from '../../secondarySideBar.store'
import { centralErrorMessage } from '../centralLoad'
import type { HealthClient } from './healthApi'
import {
  DISMISS_PRESETS, DISMISS_REASON_MAX, HL, LEVELS, SEVERITY_ICON, dismissReason, fileLabel, fixRequest,
  joinRoot, locationOf, metricsOf, needsVerify, type FindingGroup,
} from './healthModel'

/** What every row of one project shares; `root` (the project folder) lets a row open its file. */
export interface RowContext { client: HealthClient; projectName: string; root?: string; onChanged: () => void }

function DismissForm({ title, busy, onCancel, onReason, action }: { title: string; busy: boolean; onCancel: () => void; onReason: (reason: string) => void; action: Action<unknown> }) {
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
      <ActionButton type="button" size="sm" disabled={busy || reason === ''} action={action} busyLabel="Dismissing…" onClick={() => onReason(reason)}>{HL.dismissConfirm}</ActionButton>
    </div>
  )
}

const icon = (name: string) => <span className={`codicon codicon-${name}`} aria-hidden="true" />
const severityIcon = (f: Pick<FindingView, 'severity'>) => <span className={`codicon codicon-${SEVERITY_ICON[f.severity]} health-sev`} data-severity={f.severity} aria-hidden="true" />

function Details({ id, view }: { id: string; view: FindingView }) {
  return (
    <div id={id} className="health-row__details">
      <dl>
        <dt>{view.rule === 'file_size' ? HL.metrics : HL.evidence}</dt><dd className="health-pre">{metricsOf(view)}</dd>
        <dt>{HL.rule}</dt>
        <dd>
          {view.source} · {HL.confidence(view.confidence)}
          {needsVerify(view.confidence) && <> <span className="ccp-badge ccp-badge--warn">{HL.verifyFirst}</span></>}
        </dd>
        {view.origin === 'analysis' && <><dt>{HL.verifiedQuote}</dt><dd>{HL.verifiedQuoteHint}</dd></>}
        <dt>{HL.suggestion}</dt><dd>{view.suggestion}</dd>
      </dl>
      <p className="ccp-row__meta">{HL.seen(relativeTime(view.firstSeenAt), relativeTime(view.lastSeenAt))}</p>
      {view.status === 'dismissed' && view.dismissedReason && <p className="ccp-row__meta">{HL.dismissedBecause(view.dismissedReason)}</p>}
      {view.status === 'fixed' && view.fixedAt !== null && <p className="ccp-row__meta">{HL.fixedAt(relativeTime(view.fixedAt))}</p>}
    </div>
  )
}

/** One finding; `child` = inside a group, so the line shows the metric instead of the shared title. */
export function HealthFinding({ finding, ctx, child = false }: { finding: FindingView; ctx: RowContext; child?: boolean }) {
  const [view, setView] = useState(finding)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [copied, setCopied] = useState(false)
  const reason = useRef('')
  const failure = (err: unknown) => centralErrorMessage(err, HL.actionFailed)
  const dismiss = useAction(async () => { setView(await ctx.client.dismiss(view.id, reason.current)); setAsking(false); ctx.onChanged() }, { label: HL.dismiss, success: () => 'Dismissed', failure })
  const reopen = useAction(async () => { setView(await ctx.client.reopen(view.id)); ctx.onChanged() }, { label: HL.reopen, success: () => 'Reopened', failure })
  const busy = dismiss.busy || reopen.busy
  const detailsId = `health-details-${view.id}`
  const path = ctx.root ? joinRoot(ctx.root, view.file) : view.file
  // The canvas "open file in an editor node at a line" action (App registers it; LSP links use it too).
  const opener = lspFileOpener()
  const canOpen = ctx.root !== undefined && opener !== null
  const openFile = (): void => opener?.(path, view.line ?? 0, 0)
  // No Clipboard API outside a secure context: the tooltip of the file still shows the path to copy by hand.
  const copy = (): void => {
    navigator.clipboard?.writeText(path).then(() => setCopied(true), (err: unknown) => console.warn('health: copying the path failed', err))
  }
  return (
    <li className="health-row" data-status={view.status} aria-busy={busy}>
      <div className="health-row__line">
        <Button type="button" size="sm" variant="ghost" className="health-row__toggle" aria-expanded={open} aria-controls={detailsId} aria-label={HL.details(view.title)} onClick={() => setOpen((o) => !o)}>
          {icon(`chevron-${open ? 'down' : 'right'}`)}{severityIcon(view)}
          <span className="health-row__text">{child ? metricsOf(view) : view.title}</span>
        </Button>
        <IconTooltip label={locationOf({ file: path, line: view.line })} disabled={!canOpen} disabledReason={HL.cannotOpen}>
          <Button type="button" size="xs" variant="link" className="health-file" disabled={!canOpen} onClick={openFile}>{fileLabel(view)}</Button>
        </IconTooltip>
        <span role="group" aria-label={HL.actionsLabel(view.title)} className="health-row__actions">
          <IconButton type="button" size="icon-xs" label={HL.openFile} disabled={!canOpen} disabledReason={HL.cannotOpen} onClick={openFile}>{icon('go-to-file')}</IconButton>
          <IconButton type="button" size="icon-xs" label={copied ? HL.copied : HL.copy} onClick={copy}>{icon(copied ? 'check' : 'copy')}</IconButton>
          {view.status === 'open' && <IconButton type="button" size="icon-xs" label={HL.askFix} onClick={() => draftCentralChat(fixRequest(ctx.projectName, view))}>{icon('sparkle')}</IconButton>}
          {view.status === 'open' && !asking && <IconButton type="button" size="icon-xs" label={HL.dismissLabel(view.title)} tooltip={HL.dismiss} disabled={busy} onClick={() => setAsking(true)}>{icon('close')}</IconButton>}
          {view.status === 'dismissed' && <ActionButton type="button" size="xs" variant="secondary" aria-label={HL.reopenLabel(view.title)} disabled={busy} action={reopen} busyLabel="Reopening…">{HL.reopen}</ActionButton>}
        </span>
      </div>
      {open && <Details id={detailsId} view={view} />}
      {asking && <DismissForm title={view.title} busy={busy} onCancel={() => setAsking(false)} onReason={(r) => { reason.current = r }} action={dismiss} />}
      <ActionResult action={dismiss} />
      <ActionResult action={reopen} />
    </li>
  )
}

/** A kind with several findings: one collapsible row "title (n)"; a lone finding is a plain row. */
export function HealthFindingGroup({ group, ctx }: { group: FindingGroup; ctx: RowContext }) {
  const [open, setOpen] = useState(false)
  const [only] = group.items
  if (group.items.length === 1 && only) return <HealthFinding finding={only} ctx={ctx} />
  const worst = LEVELS.find((l) => group.items.some((f) => f.severity === l)) ?? 'low'
  const itemsId = `health-group-${group.items[0]?.id ?? ''}`
  return (
    <li className="health-group">
      <div className="health-row__line">
        <Button type="button" size="sm" variant="ghost" className="health-row__toggle" aria-expanded={open} aria-controls={itemsId} aria-label={HL.group(group.title, group.items.length)} onClick={() => setOpen((o) => !o)}>
          {icon(`chevron-${open ? 'down' : 'right'}`)}{severityIcon({ severity: worst })}
          <span className="health-row__text">{group.title}</span>
          <span className="health-count" aria-hidden="true">{group.items.length}</span>
        </Button>
      </div>
      {open && <ul id={itemsId} className="ccp-list health-group__items">{group.items.map((f) => <HealthFinding key={f.id} finding={f} ctx={ctx} child />)}</ul>}
    </li>
  )
}
