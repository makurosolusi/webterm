// Deep analysis control of the Health tab: start (costs model spend), running, cooldown, failed and last-result states.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { relativeTime } from '../../SessionHistory.model'
import { InboxApiError } from '../../inboxTypes'
import { centralErrorMessage, useLoad } from '../centralLoad'
import type { HealthClient } from './healthApi'
import { ANALYSIS_COOLDOWN, ANALYSIS_RUNNING, HL, SCAN_POLL_MS } from './healthModel'

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** `onFinished` runs once when an analysis this view saw running has ended (its findings changed). */
export function HealthAnalysis({ client, projectId, visible, onFinished }: { client: HealthClient; projectId: string; visible: boolean; onFinished: () => void }) {
  const state = useLoad((signal) => client.getAnalysis(projectId, signal))
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const data = state.data
  const running = starting || data?.running === true || data?.scan?.status === 'running'
  useEffect(() => {
    if (!running || !visible) return
    const timer = setInterval(state.reload, SCAN_POLL_MS)
    return () => clearInterval(timer)
  }, [running, visible, state.reload])
  const wasRunning = useRef(running)
  const finished = useRef(onFinished)
  finished.current = onFinished
  useEffect(() => {
    if (wasRunning.current && !running) finished.current()
    wasRunning.current = running
  }, [running])
  // `starting` covers the gap between the POST and the first state that shows the run.
  const awaiting = useRef(false)
  useEffect(() => { if (awaiting.current) { awaiting.current = false; setStarting(false) } }, [data])

  const start = async (): Promise<void> => {
    setStarting(true)
    setError(null)
    try {
      await client.analyze(projectId)
    } catch (err) {
      // Running elsewhere or cooling down: the reload below shows that state; anything else is an error.
      const known = err instanceof InboxApiError && (err.code === ANALYSIS_RUNNING || err.code === ANALYSIS_COOLDOWN)
      if (!known) setError(centralErrorMessage(err, HL.analyzeFailed))
    }
    awaiting.current = true
    state.reload()
  }

  if (!data) return null // the summary above already shows load errors and the off state
  const last = data.scan
  const coolingUntil = !running && data.retryAt !== null && data.retryAt > Date.now() ? data.retryAt : null
  const dropped = Object.values(data.dropped ?? {}).reduce((a, b) => a + b, 0)
  return (
    <div className="health-analysis" role="group" aria-label={HL.analyze}>
      <Button type="button" size="sm" variant="secondary" disabled={running || coolingUntil !== null} aria-busy={running} onClick={() => void start()}>
        {running && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}{running ? HL.analyzing : HL.analyze}
      </Button>
      <span className="ccp-row__meta">{HL.analyzeCost}</span>
      {coolingUntil !== null && <span className="ccp-row__meta">{HL.analyzeAgain(clock(coolingUntil))}</span>}
      {!running && last?.status === 'done' && (
        <span className="ccp-row__meta">{HL.lastAnalysis(relativeTime(last.finishedAt ?? last.startedAt), last.opened)}{dropped > 0 && ` · ${HL.droppedClaims(dropped)}`}</span>
      )}
      {!running && last?.status === 'failed' && <p role="alert" className="ccp-error">{HL.lastAnalysisFailed(last.error)}</p>}
      {error && <p role="alert" className="ccp-error">{error}</p>}
    </div>
  )
}
