// Central's Health tab: per-project findings with evidence, the latest scan, a manual scan and the deep analysis.
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { HealthRule } from '../../../shared/centralHealth'
import { relativeTime } from '../../SessionHistory.model'
import { InboxApiError } from '../../inboxTypes'
import { openCentralSettings } from '../LevelPanel'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { centralErrorMessage, useLiveRefresh, useLoad, usePaged } from '../centralLoad'
import { HealthAnalysis } from './HealthAnalysis'
import { HealthFinding } from './HealthFinding'
import { healthApi, type HealthClient, type HealthSummaryView } from './healthApi'
import { DEFAULT_FILTER, HEALTH_PROJECT_KEY, HL, LEVELS, LEVEL_LABEL, ORIGINS, ORIGIN_LABEL, RULES, RULE_LABEL, SCAN_POLL_MS, SCAN_RUNNING, STATUSES, STATUS_LABEL, isGone, isNoRepoError, isOff, type FindingFilter } from './healthModel'
import './health.css'

const ALL = 'all'

function remembered(): string | null {
  try { return localStorage.getItem(HEALTH_PROJECT_KEY) } catch (err) { console.warn('health: reading the remembered project failed', err); return null }
}
function remember(id: string): void {
  try { localStorage.setItem(HEALTH_PROJECT_KEY, id) } catch (err) { console.warn('health: remembering the project failed', err) }
}

function Off() {
  return (
    <div className="ccp-off" data-central-off="health">
      <p>{HL.off}</p>
      <Button type="button" size="sm" variant="secondary" onClick={openCentralSettings}>{HL.openSettings}</Button>
    </div>
  )
}

function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div role="alert" className="ccp-error">{text} <Button type="button" size="xs" variant="secondary" onClick={onRetry}>{HL.retry}</Button></div>
}

/** One toggle button per option; `null` is "Any". */
function Choice<T extends string>({ label, options, names, value, onChange, any }: { label: string; options: T[]; names: Record<T, string>; value: T | undefined; onChange: (v: T | undefined) => void; any?: boolean }) {
  const pick = (v: T | undefined, text: string) => (
    <Button key={v ?? ALL} type="button" size="xs" variant={value === v ? 'default' : 'secondary'} aria-pressed={value === v} onClick={() => onChange(v)}>{text}</Button>
  )
  return <div role="group" aria-label={label} className="health-choice">{any && pick(undefined, HL.any)}{options.map((o) => pick(o, names[o]))}</div>
}

function Header({ summary, running, onScan }: { summary: HealthSummaryView; running: boolean; onScan: () => void }) {
  const scan = summary.lastScan
  return (
    <div className="health-header">
      <span aria-label={HL.countsLabel} role="group" className="health-counts">
        <strong>{HL.counts(summary.open)}</strong>
        {LEVELS.map((l) => <span key={l} className="health-chip" data-severity={l}>{LEVEL_LABEL[l]} {summary[l]}</span>)}
      </span>
      {scan && scan.status === 'done' && <span className="ccp-row__meta">{HL.lastScan(relativeTime(scan.finishedAt ?? scan.startedAt), scan.filesScanned)}</span>}
      {scan?.truncated && <span className="ccp-badge ccp-badge--warn" title={HL.partialHint}>{HL.partial}</span>}
      <Button type="button" size="sm" disabled={running} aria-busy={running} onClick={onScan}>
        {running && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}{running ? HL.scanning : HL.scanNow}
      </Button>
    </div>
  )
}

function Findings({ client, projectId, filter, lastScanAt }: { client: HealthClient; projectId: string; filter: FindingFilter; lastScanAt: number | null }) {
  const list = usePaged((offset, signal) => client.listFindings(projectId, filter, { limit: CENTRAL_PAGE_SIZE, offset }, signal).then((p) => p.items))
  const filtered = filter.status !== DEFAULT_FILTER.status || filter.severity !== undefined || filter.rule !== undefined || filter.origin !== undefined
  return (
    <>
      {list.error && <Failed text={list.error} onRetry={list.reload} />}
      {list.loading && list.items.length === 0 && <p role="status">{HL.loading}</p>}
      {!list.loading && !list.error && list.items.length === 0 && <p>{filtered ? HL.noMatch : HL.empty(lastScanAt === null ? null : relativeTime(lastScanAt))}</p>}
      {list.items.length > 0 && <ul className="ccp-list" aria-label={HL.listLabel}>{list.items.map((f) => <HealthFinding key={f.id} finding={f} client={client} />)}</ul>}
      {list.hasMore && <Button type="button" size="sm" variant="secondary" onClick={list.loadMore}>{HL.loadMore}</Button>}
    </>
  )
}

function HealthBody({ client, projectId, visible }: { client: HealthClient; projectId: string; visible: boolean }) {
  const summary = useLoad((signal) => client.getSummary(projectId, signal))
  const [filter, setFilter] = useState<FindingFilter>(DEFAULT_FILTER)
  const [starting, setStarting] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [listKey, setListKey] = useState(0)
  const data = summary.data
  const running = starting || data?.running === true || data?.lastScan?.status === 'running'
  useLiveRefresh(visible, summary.reload)
  useEffect(() => {
    if (!running || !visible) return
    const timer = setInterval(summary.reload, SCAN_POLL_MS)
    return () => clearInterval(timer)
  }, [running, visible, summary.reload])
  // A scan that just ended changed the findings: reload the list once.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setListKey((k) => k + 1)
    wasRunning.current = running
  }, [running])
  // `starting` covers the gap between the POST and the first summary that shows the scan.
  const awaiting = useRef(false)
  useEffect(() => { if (awaiting.current) { awaiting.current = false; setStarting(false) } }, [data])

  const scan = async (): Promise<void> => {
    setStarting(true)
    setScanError(null)
    try {
      await client.scan(projectId)
    } catch (err) {
      if (!(err instanceof InboxApiError && err.code === SCAN_RUNNING)) setScanError(centralErrorMessage(err, HL.scanFailed))
    }
    awaiting.current = true
    summary.reload()
  }

  if (isOff(summary.code)) return <Off />
  if (isGone(summary.code)) return <p role="alert" className="ccp-error">{HL.gone}</p>
  if (summary.loading && !data) return <p role="status">{HL.loading}</p>
  if (!data) return <Failed text={summary.error ?? HL.loadFailed} onRetry={summary.reload} />
  const last = data.lastScan
  return (
    <>
      <Header summary={data} running={running} onScan={() => void scan()} />
      {summary.error && <Failed text={summary.error} onRetry={summary.reload} />}
      <HealthAnalysis client={client} projectId={projectId} visible={visible} onFinished={() => { setListKey((k) => k + 1); summary.reload() }} />
      {scanError && <p role="alert" className="ccp-error">{scanError}</p>}
      {!running && last?.status === 'failed' && <p role="alert" className="ccp-error">{isNoRepoError(last.error) ? HL.noRepo : HL.lastScanFailed(last.error)}</p>}
      {!last && !running ? (
        <div className="health-cta">
          <p>{HL.neverScanned}</p>
          <Button type="button" size="sm" onClick={() => void scan()}>{HL.runScan}</Button>
        </div>
      ) : (
        <>
          <div className="ccp-filters" role="group" aria-label={HL.filtersLabel}>
            <Choice label={HL.statusLabel} options={STATUSES} names={STATUS_LABEL} value={filter.status} onChange={(status) => setFilter({ ...filter, status: status ?? 'open' })} />
            <Choice label={HL.severityLabel} options={LEVELS} names={LEVEL_LABEL} value={filter.severity} any onChange={(severity) => setFilter({ ...filter, severity })} />
            <Choice label={HL.originLabel} options={ORIGINS} names={ORIGIN_LABEL} value={filter.origin} any onChange={(origin) => setFilter({ ...filter, origin })} />
            <Select value={filter.rule ?? ALL} onValueChange={(v) => setFilter({ ...filter, rule: v === ALL ? undefined : v as HealthRule })}>
              <SelectTrigger aria-label={HL.ruleLabel}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{HL.allRules}</SelectItem>
                {RULES.map((r) => <SelectItem key={r} value={r}>{RULE_LABEL[r]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {/* A changed filter or finished scan is a different list: the key drops old rows and any in-flight page. */}
          <Findings key={`${filter.status}-${filter.severity}-${filter.rule}-${filter.origin}-${listKey}`} client={client} projectId={projectId} filter={filter} lastScanAt={last?.finishedAt ?? null} />
        </>
      )}
    </>
  )
}

export default function HealthView({ client = healthApi, visible = true }: { client?: HealthClient; visible?: boolean }) {
  const projects = useLoad((signal) => client.listProjects(signal))
  const [picked, setPicked] = useState(remembered)
  const list = projects.data ?? []
  const projectId = list.find((p) => p.id === picked)?.id ?? list[0]?.id
  return (
    <section className="ccp-section health" aria-labelledby="ccp-health-h">
      <h3 id="ccp-health-h">{HL.heading}</h3>
      <p>{HL.intro}</p>
      {isOff(projects.code) ? <Off /> : (
        <>
          {projects.loading && !projects.data && <p role="status">{HL.loading}</p>}
          {projects.error && !projects.data && <Failed text={projects.error} onRetry={projects.reload} />}
          {projects.data && list.length === 0 && <p>{HL.noProjects}</p>}
          {projectId && (
            <>
              <div className="ccp-filters">
                <Select value={projectId} onValueChange={(id) => { setPicked(id); remember(id) }}>
                  <SelectTrigger aria-label={HL.project}><SelectValue /></SelectTrigger>
                  <SelectContent>{list.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <HealthBody key={projectId} client={client} projectId={projectId} visible={visible} />
            </>
          )}
        </>
      )}
    </section>
  )
}
