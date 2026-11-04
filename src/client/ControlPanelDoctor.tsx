// Doctor section of the Control tab (F1-f): the server runs the checks (GET /api/control/doctor) and applies a
// safe fix (POST {fix}); this only renders status, explanation and the Fix button, then shows the re-run result.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CONTROL_DOCTOR_PATH, controlRequest } from './ControlPanel'
import { DOCTOR_TEXT } from './controlPanelLabels'

/** Mirror of the server `DoctorCheck` (src/server/doctor.ts). */
export interface DoctorCheck { id: string; title: string; status: 'ok' | 'warn' | 'fail' | 'off'; detail: string; fix?: string }

const BADGE: Record<DoctorCheck['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  ok: 'secondary', warn: 'outline', fail: 'destructive', off: 'outline',
}
const isChecks = (v: unknown): v is { checks: DoctorCheck[] } => !!v && Array.isArray((v as { checks?: unknown }).checks)
const isCheck = (v: unknown): v is DoctorCheck => !!v && typeof (v as DoctorCheck).id === 'string' && typeof (v as DoctorCheck).status === 'string'

export function ControlPanelDoctor(): React.JSX.Element {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [fixError, setFixError] = useState<string | null>(null)

  const load = useCallback(() => {
    setChecks(null)
    setFailed(false)
    controlRequest('GET', undefined, '', CONTROL_DOCTOR_PATH)
      .then((v) => { if (isChecks(v)) setChecks(v.checks); else setFailed(true) })
      .catch(() => setFailed(true)) // shown as the loadFailed alert
  }, [])
  useEffect(load, [load])

  const fix = async (id: string): Promise<void> => {
    setFixing(id)
    setFixError(null)
    try {
      const next = await controlRequest('POST', { fix: id }, '', CONTROL_DOCTOR_PATH)
      if (isCheck(next)) setChecks((all) => all?.map((c) => (c.id === id ? next : c)) ?? null)
    } catch {
      setFixError(id) // the explanation of the re-checked row says what is still wrong
      load()
    } finally {
      setFixing(null)
    }
  }

  return (
    <section aria-label={DOCTOR_TEXT.title} data-testid="doctor">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{DOCTOR_TEXT.title}</h3>
        <Button size="sm" variant="secondary" onClick={load} disabled={checks === null && !failed}>{DOCTOR_TEXT.run}</Button>
      </div>
      <p className="text-xs opacity-70">{DOCTOR_TEXT.intro}</p>
      {failed ? <p role="alert" className="text-xs text-destructive">{DOCTOR_TEXT.loadFailed}</p> : null}
      {checks === null && !failed ? <p className="text-xs opacity-70">{DOCTOR_TEXT.running}</p> : null}
      {checks ? (
        <ul className="flex flex-col gap-1 text-xs">
          {checks.map((c) => (
            <li key={c.id} data-check={c.id} data-status={c.status} className="flex items-start gap-2">
              <Badge variant={BADGE[c.status]} className="min-w-16 justify-center">{DOCTOR_TEXT.status[c.status] ?? c.status}</Badge>
              <span className="flex-1"><strong>{c.title}</strong>: {c.detail}
                {fixError === c.id ? <span role="alert" className="block text-destructive">{DOCTOR_TEXT.fixFailed}</span> : null}
              </span>
              {c.fix ? (
                <Button size="sm" onClick={() => void fix(c.id)} disabled={fixing !== null}>
                  {fixing === c.id ? DOCTOR_TEXT.fixing : c.fix}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
