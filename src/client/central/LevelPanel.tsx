// Status tab: the level Central works at (in plain words), today's budget and the Stop Central switch.
// Display plus stop only: the level is set in one place, Settings › Central Agent ("Change" opens it).
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEffect, useRef, useState } from 'react'
import { openSettingsAt, type CentralFieldId } from '../settings.link'
import { useLiveSettings } from '../useSettings'
import { CL, LEVEL_MEANING, LEVEL_NAMES } from './centralLabels'
import { centralControlApi } from './centralControlApi'
import type { BudgetView, CentralControlClient, ControlView, StatusView } from './centralControlTypes'
import { centralErrorMessage, useLiveRefresh, useLoad } from './centralLoad'
import { isActiveTurnStatus, type ChatTurnStatus } from '../chat/chatTypes'
import { relativeTime } from '../SessionHistory.model'

export interface LevelPanelProps {
  client?: CentralControlClient
  /** False while the panel sits mounted behind another view; turning true again re-reads the numbers. */
  visible?: boolean
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
/** Opens Settings › Central Agent (the one place the level is set) revealing the `field` row. */
export const openCentralSettings = (field: CentralFieldId): void => openSettingsAt(CENTRAL_SETTINGS_SECTION, `central.${field}`)

/** Settings section id of the Claude section, where the approval level ("Never ask") lives. */
export const AGENT_SETTINGS_SECTION = 'claude'
const openAgentSettings = (): void => openSettingsAt(AGENT_SETTINGS_SECTION, 'agentApprovalLevel')

/** Below L2 Central cannot change anything, so skipping approvals does not alter what the level means. */
const skipApplies = (level: ControlView['effective']): boolean => level !== 'off' && level !== 'observe'

/** "Working now", "Last turn 5m ago · Idle" or "No turns yet". */
export function livenessText(turn: StatusView['lastTurn'], now = Date.now()): string {
  if (!turn) return CL.noTurns
  return isActiveTurnStatus(turn.status as ChatTurnStatus) ? CL.workingNow : CL.lastTurnIdle(relativeTime(turn.at, now))
}

export default function LevelPanel({ client = centralControlApi, visible = true, onStatus, askHalt, onHaltAsked }: LevelPanelProps) {
  const control = useLoad((s) => client.getControl(s))
  const status = useLoad((s) => client.getStatus(s))
  useLiveRefresh(visible, () => { control.reload(); status.reload() })
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
  const skipped = skipApprovals && !!c && skipApplies(c.effective)
  // The ladder names promise asking ("L3 ... asks before risky steps"), so with approvals skipped only the code stays.
  const levelName = c ? LEVEL_NAMES[c.effective] ?? c.effective : ''
  return (
    <section className="ccp-section" aria-labelledby="ccp-level-h">
      <h3 id="ccp-level-h">{CL.levelHeading}</h3>
      {control.error && <p role="alert" className="ccp-error">{control.error}</p>}
      {control.loading && !c && <p role="status">{CL.loading}</p>}
      {c && (
        <div className="ccp-level">
          <p><strong data-testid="level-effective">{skipped ? levelName.split(' ')[0] : levelName}</strong></p>
          <p>{skipped ? CL.levelApprovalsSkipped : LEVEL_MEANING[c.effective]}</p>
          {c.global.level !== c.effective && <p className="ccp-row__meta">{CL.limited}</p>}
        </div>
      )}
      <Button type="button" size="sm" variant="secondary" aria-label={CL.changeLabel} onClick={() => openCentralSettings('level')}>{CL.change}</Button>
      {skipApprovals && (
        <p className="ccp-row__meta">
          {!skipped && <>{CL.approvalsSkipped}{' '}</>}
          <Button type="button" size="sm" variant="secondary" aria-label={CL.changeApprovalsLabel} onClick={openAgentSettings}>{CL.change}</Button>
        </p>
      )}
      {statusData && <p data-testid="central-liveness">{livenessText(statusData.lastTurn)}</p>}
      <h3 id="ccp-budget-h">{CL.budgetHeading}</h3>
      {status.error && <p role="alert" className="ccp-error">{status.error}</p>}
      {status.loading && !statusData && <p role="status">{CL.loading}</p>}
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
