// Status tab: the level Central works at (in plain words), today's budget and the Stop Central switch.
// Display plus stop only: the level is set in one place, Settings › Central Agent ("Change" opens it).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'
import { OPEN_SETTINGS_EVENT } from '../claudeLauncher/claudeLaunch.client'
import { useLiveSettings } from '../useSettings'
import { CL, LEVEL_MEANING, LEVEL_NAMES } from './centralLabels'
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

const compactNum = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
/** 13000 -> "13K", 10000000 -> "10M". */
export const compact = (n: number): string => compactNum.format(n)

/** `limit` 0 means no limit for tokens; spawns 0 means none allowed, so callers pass `zeroIsUnlimited`. */
function meter(label: string, used: number, limit: number, zeroIsUnlimited: boolean, words: (u: string, l: string) => string) {
  const text = limit === 0 ? `${compact(used)} · ${zeroIsUnlimited ? CL.noLimit : CL.noneAllowed}` : words(compact(used), compact(limit))
  // Any use shows at least a sliver, so 13K of 10M does not read as an empty bar.
  const shown = limit === 0 ? 0 : used > 0 ? Math.max(Math.min(used, limit), limit / 100) : 0
  return (
    <div className="ccp-meter" key={label}>
      <label htmlFor={`ccp-meter-${label}`}>{label}</label>
      <progress id={`ccp-meter-${label}`} aria-label={label} aria-valuetext={text} value={shown} max={Math.max(limit, 1)} />
      <span>{text}</span>
    </div>
  )
}

export function budgetMeters(b: BudgetView) {
  return [meter(CL.tokens, b.used.tokens, b.limits.tokens, true, CL.tokensUsed), meter(CL.spawns, b.used.spawns, b.limits.spawns, false, CL.spawnsUsed)]
}

/** Settings section id of the Central Agent section. */
export const CENTRAL_SETTINGS_SECTION = 'central'
/** Opens Settings › Central Agent, the one place the level is set. */
export const openCentralSettings = (): void => {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: CENTRAL_SETTINGS_SECTION } }))
}

/** Settings section id of the Agent section, where Skip approvals lives. */
export const AGENT_SETTINGS_SECTION = 'agent'
const openAgentSettings = (): void => {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: AGENT_SETTINGS_SECTION } }))
}

export default function LevelPanel({ client = centralControlApi, onStatus, askHalt, onHaltAsked }: LevelPanelProps) {
  const control = useLoad((s) => client.getControl(s))
  const status = useLoad((s) => client.getStatus(s))
  const { skipApprovals } = useLiveSettings()
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
        <div className="ccp-level">
          <p><strong data-testid="level-effective">{LEVEL_NAMES[c.effective] ?? c.effective}</strong></p>
          <p>{LEVEL_MEANING[c.effective]}</p>
          {c.global.level !== c.effective && <p className="ccp-row__meta">{CL.limited}</p>}
        </div>
      )}
      <Button type="button" size="sm" variant="secondary" aria-label={CL.changeLabel} onClick={openCentralSettings}>{CL.change}</Button>
      {skipApprovals && (
        <p className="ccp-row__meta">
          {CL.approvalsSkipped}{' '}
          <Button type="button" size="sm" variant="secondary" aria-label={CL.changeApprovalsLabel} onClick={openAgentSettings}>{CL.change}</Button>
        </p>
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
