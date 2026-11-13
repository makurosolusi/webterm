// Checks card of Settings › About this machine (F1-f Doctor): the server runs the checks (GET /api/control/doctor)
// and applies a safe fix (POST {fix}). Each row: a status badge (icon + word, OK / Warning / Problem / Not in use),
// the title and explanation, "where to fix it" (`go`, a link that opens that exact Settings field) and a Fix with its
// result (busy, then what the re-check found). The header has Check again and Copy diagnostics (a plain-text report
// to paste into an issue). Machine checks only: the Control panel's Health is about code, not this machine.
import { useCallback, useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { writeClipboard } from './clipboard'
import { CONTROL_DOCTOR_PATH, controlRequest } from './ControlPanel'
import { DOCTOR_TEXT } from './controlPanelLabels'
import { CardError, CardLoading } from './SettingsCardState'
import { SettingsGroup } from './SettingsControls'
import { openSettingsAt, toSettingsFieldId } from './settings.link'
import { SETTINGS_SEARCH_INDEX } from './settings.search'

/** Mirror of the server `DoctorCheck` (src/server/doctor.ts). */
export interface DoctorCheck { id: string; title: string; status: 'ok' | 'warn' | 'fail' | 'off'; detail: string; fix?: string; go?: { field: string } }

const ICON: Record<DoctorCheck['status'], string> = { ok: 'pass', warn: 'warning', fail: 'error', off: 'circle-slash' }
const isChecks = (v: unknown): v is { checks: DoctorCheck[] } => !!v && Array.isArray((v as { checks?: unknown }).checks)
const isCheck = (v: unknown): v is DoctorCheck => !!v && typeof (v as DoctorCheck).id === 'string' && typeof (v as DoctorCheck).status === 'string'
const statusWord = (s: string): string => DOCTOR_TEXT.status[s] ?? s

/** The page and label of a field the doctor points at, from the Settings search index; null = not in Settings. */
export function doctorLink(field: string): { page: string; field: NonNullable<ReturnType<typeof toSettingsFieldId>>; label: string } | null {
  const id = toSettingsFieldId(field)
  const entry = id ? SETTINGS_SEARCH_INDEX.find((x) => x.field === id) : undefined
  return id && entry ? { page: entry.page, field: id, label: entry.label } : null
}

/** Plain-text report: one line per check, then `extra` (protection, data folder). No secrets reach it. */
export function diagnosticsText(checks: readonly DoctorCheck[], extra: readonly string[], at: Date): string {
  return [DOCTOR_TEXT.reportTitle(at.toISOString()), ...checks.map((c) => `[${statusWord(c.status)}] ${c.title}: ${c.detail}`), ...extra].join('\n')
}

/** Status badge of a check: icon + word, never colour alone. */
export function StatusBadge({ status }: { status: DoctorCheck['status'] }): React.JSX.Element {
  return (
    <span className="st-status" data-tone={status}>
      <span className={`codicon codicon-${ICON[status]}`} aria-hidden="true" />{statusWord(status)}
    </span>
  )
}

function GoLink({ field }: { field: string }): React.JSX.Element | null {
  const link = doctorLink(field)
  if (!link) return null
  return (
    <Button size="xs" variant="link" className="px-0" onClick={() => openSettingsAt(link.page, link.field)}>
      {DOCTOR_TEXT.open(link.label)}
    </Button>
  )
}

function CheckRow({ check: c, fixedBefore, onFixed }: { check: DoctorCheck; fixedBefore: boolean; onFixed: (next: DoctorCheck) => void }): React.JSX.Element {
  const fix = useAction(async () => {
    const next = await controlRequest('POST', { fix: c.id }, '', CONTROL_DOCTOR_PATH)
    if (!isCheck(next)) throw new Error(DOCTOR_TEXT.fixFailed)
    onFixed(next)
    return next
  }, {
    label: c.fix ?? DOCTOR_TEXT.fixing,
    ok: (next) => next.status === 'ok',
    success: (next) => (next.status === 'ok' ? DOCTOR_TEXT.fixed(c.title) : DOCTOR_TEXT.stillWrong),
  })
  return (
    <li data-check={c.id} data-status={c.status} className="st-field">
      <div className="st-field-text flex items-start gap-3">
        <StatusBadge status={c.status} />
        <div className="min-w-0 flex-1">
          <strong className="st-row-title font-medium">{c.title}</strong>
          <p className="st-row-meta">{c.detail}{c.go && c.status !== 'ok' ? <> <GoLink field={c.go.field} /></> : null}</p>
          {/* A fixed row keeps showing its result even when the fix removed the Fix offer. */}
          {c.fix || fixedBefore ? <ActionResult action={fix} /> : null}
        </div>
      </div>
      {c.fix ? <div className="st-control"><ActionButton size="sm" action={fix} busyLabel={DOCTOR_TEXT.fixing}>{c.fix}</ActionButton></div> : null}
    </li>
  )
}

/** `extra`: more lines for Copy diagnostics (agent protection, data folder), from the page. */
export function ControlPanelDoctor({ extra = [] }: { extra?: readonly string[] }): React.JSX.Element {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null)
  const [failed, setFailed] = useState(false)
  const running = checks === null && !failed

  const load = useCallback(() => {
    setChecks(null)
    setFailed(false)
    controlRequest('GET', undefined, '', CONTROL_DOCTOR_PATH)
      .then((v) => { if (isChecks(v)) setChecks(v.checks); else setFailed(true) })
      .catch((err: unknown) => { console.warn('doctor: the checks could not be run', err); setFailed(true) }) // shown as the loadFailed alert
  }, [])
  useEffect(load, [load])

  const [fixedIds, setFixedIds] = useState<string[]>([])
  const onFixed = (next: DoctorCheck): void => {
    setFixedIds((ids) => (ids.includes(next.id) ? ids : [...ids, next.id]))
    setChecks((all) => all?.map((c) => (c.id === next.id ? next : c)) ?? null)
  }
  const copy = useAction(async () => {
    if (!(await writeClipboard(diagnosticsText(checks ?? [], extra, new Date())))) throw new Error(DOCTOR_TEXT.copyRefused)
  }, { label: DOCTOR_TEXT.copy, success: () => DOCTOR_TEXT.copied })
  const attention = checks?.filter((c) => c.status === 'warn' || c.status === 'fail').length ?? 0

  return (
    <section aria-label={DOCTOR_TEXT.title} data-testid="doctor" className="contents">
      <SettingsGroup title={DOCTOR_TEXT.title} description={DOCTOR_TEXT.intro}>
        <div className="st-field">
          <div className="st-field-text">
            <p className="st-row-title" role="status">{checks ? DOCTOR_TEXT.summary(checks.length, attention) : running ? DOCTOR_TEXT.running : DOCTOR_TEXT.notRun}</p>
            <ActionResult action={copy} />
          </div>
          <div className="st-control">
            <Button size="sm" variant="outline" onClick={load} disabled={running} aria-busy={running}>{running ? DOCTOR_TEXT.running : DOCTOR_TEXT.run}</Button>
            <ActionButton size="sm" variant="outline" action={copy} busyLabel={DOCTOR_TEXT.copying} lock={checks ? undefined : { reason: DOCTOR_TEXT.copyNeedsChecks }}>{DOCTOR_TEXT.copy}</ActionButton>
          </div>
        </div>
        {failed ? <CardError text={DOCTOR_TEXT.loadFailed} onRetry={load} /> : null}
        {running ? <CardLoading text={DOCTOR_TEXT.running} /> : null}
        {checks ? (
          <ul className="st-list" aria-label={DOCTOR_TEXT.title}>
            {checks.map((c) => <CheckRow key={c.id} check={c} fixedBefore={fixedIds.includes(c.id)} onFixed={onFixed} />)}
          </ul>
        ) : null}
      </SettingsGroup>
    </section>
  )
}
