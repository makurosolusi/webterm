// Doctor in Settings › Health (F1-f): the server runs the checks (GET /api/control/doctor) and applies a
// safe fix (POST {fix}). Each row shows status and explanation; "where to fix it" (`go`) is a link that
// opens that exact Settings field, and a Fix shows its result (busy, then what the re-check found).
import { useCallback, useEffect, useState } from 'react'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CONTROL_DOCTOR_PATH, controlRequest } from './ControlPanel'
import { DOCTOR_TEXT } from './controlPanelLabels'
import { openSettingsAt, toSettingsFieldId } from './settings.link'
import { SETTINGS_SEARCH_INDEX } from './settings.search'

/** Mirror of the server `DoctorCheck` (src/server/doctor.ts). */
export interface DoctorCheck { id: string; title: string; status: 'ok' | 'warn' | 'fail' | 'off'; detail: string; fix?: string; go?: { field: string } }

const BADGE: Record<DoctorCheck['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ok: 'secondary', warn: 'outline', fail: 'destructive', off: 'outline',
}
const isChecks = (v: unknown): v is { checks: DoctorCheck[] } => !!v && Array.isArray((v as { checks?: unknown }).checks)
const isCheck = (v: unknown): v is DoctorCheck => !!v && typeof (v as DoctorCheck).id === 'string' && typeof (v as DoctorCheck).status === 'string'

/** The page and label of a field the doctor points at, from the Settings search index; null = not in Settings. */
export function doctorLink(field: string): { page: string; field: NonNullable<ReturnType<typeof toSettingsFieldId>>; label: string } | null {
  const id = toSettingsFieldId(field)
  const entry = id ? SETTINGS_SEARCH_INDEX.find((x) => x.field === id) : undefined
  return id && entry ? { page: entry.page, field: id, label: entry.label } : null
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

function FixButton({ check, onFixed }: { check: DoctorCheck; onFixed: (next: DoctorCheck) => void }): React.JSX.Element {
  const fix = useAction(async () => {
    const next = await controlRequest('POST', { fix: check.id }, '', CONTROL_DOCTOR_PATH)
    if (!isCheck(next)) throw new Error(DOCTOR_TEXT.fixFailed)
    onFixed(next)
    return next
  }, {
    label: check.fix ?? DOCTOR_TEXT.fixing,
    ok: (next) => next.status === 'ok',
    success: (next) => (next.status === 'ok' ? DOCTOR_TEXT.fixed(check.title) : DOCTOR_TEXT.stillWrong),
  })
  return (
    <span className="flex flex-col items-end gap-1">
      {check.fix ? <ActionButton size="sm" action={fix} busyLabel={DOCTOR_TEXT.fixing}>{check.fix}</ActionButton> : null}
      <ActionResult action={fix} />
    </span>
  )
}

export function ControlPanelDoctor(): React.JSX.Element {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null)
  const [failed, setFailed] = useState(false)
  const running = checks === null && !failed

  const load = useCallback(() => {
    setChecks(null)
    setFailed(false)
    controlRequest('GET', undefined, '', CONTROL_DOCTOR_PATH)
      .then((v) => { if (isChecks(v)) setChecks(v.checks); else setFailed(true) })
      .catch(() => setFailed(true)) // shown as the loadFailed alert
  }, [])
  useEffect(load, [load])

  // A fixed row keeps showing its result even when the fix removed the Fix offer.
  const [fixedIds, setFixedIds] = useState<string[]>([])
  const onFixed = (next: DoctorCheck): void => {
    setFixedIds((ids) => (ids.includes(next.id) ? ids : [...ids, next.id]))
    setChecks((all) => all?.map((c) => (c.id === next.id ? next : c)) ?? null)
  }

  return (
    <section aria-label={DOCTOR_TEXT.title} data-testid="doctor">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{DOCTOR_TEXT.title}</h3>
        <Button size="sm" variant="secondary" onClick={load} disabled={running} aria-busy={running}>{running ? DOCTOR_TEXT.running : DOCTOR_TEXT.run}</Button>
      </div>
      <p className="text-xs opacity-70">{DOCTOR_TEXT.intro}</p>
      {failed ? <p role="alert" className="text-xs text-destructive">{DOCTOR_TEXT.loadFailed}</p> : null}
      {running ? <p className="text-xs opacity-70">{DOCTOR_TEXT.running}</p> : null}
      {checks ? (
        <ul className="flex flex-col gap-1 text-xs">
          {checks.map((c) => (
            <li key={c.id} data-check={c.id} data-status={c.status} className="flex items-start gap-2">
              <Badge variant={BADGE[c.status]} className="min-w-16 justify-center">{DOCTOR_TEXT.status[c.status] ?? c.status}</Badge>
              <span className="flex-1"><strong>{c.title}</strong>: {c.detail}
                {c.go && c.status !== 'ok' ? <> <GoLink field={c.go.field} /></> : null}
              </span>
              {c.fix || fixedIds.includes(c.id) ? <FixButton check={c} onFixed={onFixed} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
