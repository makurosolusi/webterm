// Level, daily budget and kill-switch. Display plus halt only: changing the level stays a human
// act through the control API (ponytail: no level selector until asked).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'
import { CL, LEVEL_NAMES } from './centralLabels'
import { centralControlApi } from './centralControlApi'
import type { BudgetView, CentralControlClient, StatusView } from './centralControlTypes'
import { centralErrorMessage, useLoad } from './centralLoad'

export interface LevelPanelProps {
  client?: CentralControlClient
  /** Reports the status (model, budget) to the host so it can show the privacy label. */
  onStatus?: (status: StatusView) => void
  /** `/halt` from the Central chat: open the same kill-switch confirmation, then report it via `onHaltAsked`. */
  askHalt?: boolean
  onHaltAsked?: () => void
}

/** `limit` 0 means unlimited for tokens; spawns 0 means none allowed, so callers pass `zeroIsUnlimited`. */
function meter(label: string, used: number, limit: number, zeroIsUnlimited: boolean) {
  const unlimited = zeroIsUnlimited && limit === 0
  const left = unlimited ? CL.unlimited : `${Math.max(limit - used, 0)} ${CL.remaining}`
  return (
    <div className="ccp-meter" key={label}>
      <label htmlFor={`ccp-meter-${label}`}>{label}</label>
      <progress id={`ccp-meter-${label}`} aria-label={label} value={unlimited ? 0 : Math.min(used, limit)} max={Math.max(limit, 1)} />
      <span>{used} / {unlimited ? CL.unlimited : limit} ({left})</span>
    </div>
  )
}

export function budgetMeters(b: BudgetView) {
  return [meter(CL.tokens, b.used.tokens, b.limits.tokens, true), meter(CL.spawns, b.used.spawns, b.limits.spawns, false)]
}

export default function LevelPanel({ client = centralControlApi, onStatus, askHalt, onHaltAsked }: LevelPanelProps) {
  const control = useLoad((s) => client.getControl(s))
  const status = useLoad((s) => client.getStatus(s))
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const statusData = status.data
  useEffect(() => { if (statusData) onStatus?.(statusData) }, [statusData, onStatus])
  useEffect(() => { if (confirming) cancelRef.current?.focus() }, [confirming])
  useEffect(() => {
    if (!askHalt) return
    setMsg(null)
    setConfirming(true)
    onHaltAsked?.()
  }, [askHalt, onHaltAsked])

  const doHalt = async () => {
    try {
      await client.halt(reason.trim())
      setMsg({ ok: true, text: CL.haltDone })
      control.reload()
    } catch (err) {
      setMsg({ ok: false, text: centralErrorMessage(err, CL.actionFailed) })
    }
    setConfirming(false)
  }

  const c = control.data
  return (
    <section className="ccp-section" aria-labelledby="ccp-level-h">
      <h3 id="ccp-level-h">{CL.levelHeading}</h3>
      {control.error && <p role="alert" className="ccp-error">{control.error}</p>}
      {control.loading && !c && <p role="status">{CL.loading}</p>}
      {c && (
        <dl className="ccp-kv">
          <dt>{CL.effective}</dt><dd data-testid="level-effective">{LEVEL_NAMES[c.effective] ?? c.effective}</dd>
          <dt>{CL.globalLevel}</dt><dd>{LEVEL_NAMES[c.global.level] ?? c.global.level}</dd>
          <dt>{CL.ceiling}</dt><dd>{LEVEL_NAMES[c.ceiling] ?? c.ceiling}</dd>
        </dl>
      )}
      <h3 id="ccp-budget-h">{CL.budgetHeading}</h3>
      {status.error && <p role="alert" className="ccp-error">{status.error}</p>}
      {statusData && <div role="group" aria-labelledby="ccp-budget-h">{budgetMeters(statusData.budget)}</div>}
      <div className="ccp-halt">
        {!confirming && <Button type="button" size="sm" variant="destructive" onClick={() => { setMsg(null); setConfirming(true) }}>{CL.haltButton}</Button>}
        {confirming && (
          <div role="alertdialog" aria-modal="false" aria-labelledby="ccp-halt-q" className="ccp-confirm" onKeyDown={(e) => { if (e.key === 'Escape') setConfirming(false) }}>
            <p id="ccp-halt-q">{CL.haltPrompt}</p>
            <Input aria-label={CL.haltReason} placeholder={CL.haltReason} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            <Button type="button" size="sm" variant="secondary" ref={cancelRef} onClick={() => setConfirming(false)}>{CL.haltCancel}</Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void doHalt()}>{CL.haltConfirm}</Button>
          </div>
        )}
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? undefined : 'ccp-error'}>{msg.text}</p>}
      </div>
    </section>
  )
}
