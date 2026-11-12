// Central's Health tab, laid out like a Problems panel: one header row (project, summary, Scan now, Deep analysis,
// an (i) explanation), status tabs with counts, severity toggles plus one Filter select, then grouped one-line rows.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { FindingOrigin, FindingStatus, HealthLevel, HealthRule } from '../../../shared/centralHealth'
import { relativeTime } from '../../SessionHistory.model'
import { InboxApiError } from '../../inboxTypes'
import { openCentralSettings } from '../LevelPanel'
import { CENTRAL_PAGE_SIZE } from '../centralControlApi'
import { centralErrorMessage, useLiveRefresh, useLoad, usePaged } from '../centralLoad'
import { HealthAnalysis } from './HealthAnalysis'
import { HealthFindingGroup, type RowContext } from './HealthFinding'
import { healthApi, type HealthClient, type HealthSummaryView } from './healthApi'
import {
  DEFAULT_FILTER, HEALTH_PROJECT_KEY, HL, LEVELS, LEVEL_LABEL, NUMBER, ORIGINS, ORIGIN_LABEL, RULES, RULE_LABEL, SCAN_POLL_MS, SCAN_RUNNING,
  SEVERITY_ICON, STATUSES, STATUS_LABEL, groupFindings, isGone, isNoRepoError, isOff, type FindingFilter, type HealthProject,
} from './healthModel'
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
      <Button type="button" size="sm" variant="secondary" onClick={() => openCentralSettings('central')}>{HL.openSettings}</Button>
    </div>
  )
}

function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div role="alert" className="ccp-error">{text} <Button type="button" size="xs" variant="secondary" onClick={onRetry}>{HL.retry}</Button></div>
}

/** Source and rule share one select: `origin:scan`, `rule:file_size` or `all`. Rule `analysis` is the same set as
 *  source Analysis, so only the source is offered. */
const filterValue = (f: FindingFilter): string => (f.origin ? `origin:${f.origin}` : f.rule ? `rule:${f.rule}` : ALL)
function FilterSelect({ filter, onChange }: { filter: FindingFilter; onChange: (f: FindingFilter) => void }) {
  const pick = (v: string): void => {
    const [kind, value] = v.split(':')
    onChange({ status: filter.status, severity: filter.severity, origin: kind === 'origin' ? value as FindingOrigin : undefined, rule: kind === 'rule' ? value as HealthRule : undefined })
  }
  return (
    <Select value={filterValue(filter)} onValueChange={pick}>
      <SelectTrigger size="sm" aria-label={HL.filter} className="health-filter"><span className="codicon codicon-filter" aria-hidden="true" /><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{HL.anyFilter}</SelectItem>
        <SelectGroup><SelectLabel>{HL.originLabel}</SelectLabel>{ORIGINS.map((o) => <SelectItem key={o} value={`origin:${o}`}>{ORIGIN_LABEL[o]}</SelectItem>)}</SelectGroup>
        <SelectGroup><SelectLabel>{HL.ruleLabel}</SelectLabel>{RULES.filter((r) => r !== 'analysis').map((r) => <SelectItem key={r} value={`rule:${r}`}>{RULE_LABEL[r]}</SelectItem>)}</SelectGroup>
      </SelectContent>
    </Select>
  )
}

function Filters({ filter, onChange, summary, counts }: { filter: FindingFilter; onChange: (f: FindingFilter) => void; summary: HealthSummaryView; counts: Partial<Record<FindingStatus, string>> }) {
  const toggle = (l: HealthLevel): void => onChange({ ...filter, severity: filter.severity === l ? undefined : l })
  return (
    <>
      <Tabs value={filter.status} onValueChange={(v) => onChange({ ...filter, status: v as FindingStatus })}>
        <TabsList aria-label={HL.statusLabel} className="health-tabs">
          {STATUSES.map((s) => <TabsTrigger key={s} value={s}>{STATUS_LABEL[s]}{counts[s] !== undefined && <span className="health-count">{counts[s]}</span>}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="health-toolbar" role="group" aria-label={HL.filtersLabel}>
        <span role="group" aria-label={HL.severityLabel} className="health-sevs">
          {LEVELS.map((l) => (
            <Button key={l} type="button" size="xs" variant="ghost" className="health-chip" data-severity={l} aria-pressed={filter.severity === l} onClick={() => toggle(l)}>
              <span className={`codicon codicon-${SEVERITY_ICON[l]} health-sev`} data-severity={l} aria-hidden="true" />
              {HL.severityFilter(LEVEL_LABEL[l], filter.status === 'open' ? summary[l] : null)}
            </Button>
          ))}
        </span>
        <FilterSelect filter={filter} onChange={onChange} />
      </div>
    </>
  )
}

function Findings({ ctx, projectId, filter, lastScanAt }: { ctx: RowContext; projectId: string; filter: FindingFilter; lastScanAt: number | null }) {
  const list = usePaged((offset, signal) => ctx.client.listFindings(projectId, filter, { limit: CENTRAL_PAGE_SIZE, offset }, signal).then((p) => p.items))
  const filtered = filter.status !== DEFAULT_FILTER.status || filter.severity !== undefined || filter.rule !== undefined || filter.origin !== undefined
  return (
    <>
      {list.error && <Failed text={list.error} onRetry={list.reload} />}
      {list.loading && list.items.length === 0 && <p role="status">{HL.loading}</p>}
      {!list.loading && !list.error && list.items.length === 0 && <p>{filtered ? HL.noMatch : HL.empty(lastScanAt === null ? null : relativeTime(lastScanAt))}</p>}
      {list.items.length > 0 && <ul className="ccp-list health-list" aria-label={HL.listLabel}>{groupFindings(list.items).map((g) => <HealthFindingGroup key={g.key} group={g} ctx={ctx} />)}</ul>}
      {list.hasMore && <Button type="button" size="sm" variant="secondary" onClick={list.loadMore}>{HL.loadMore}</Button>}
    </>
  )
}

function HealthBody({ client, project, picker, visible }: { client: HealthClient; project: HealthProject; picker: ReactNode; visible: boolean }) {
  const projectId = project.id
  const summary = useLoad((signal) => client.getSummary(projectId, signal))
  const counts = useLoad(async (signal) => {
    const [dismissed, fixed] = await Promise.all([client.countFindings(projectId, 'dismissed', signal), client.countFindings(projectId, 'fixed', signal)])
    const text = (c: { count: number; more: boolean }) => `${NUMBER.format(c.count)}${c.more ? '+' : ''}`
    return { dismissed: text(dismissed), fixed: text(fixed) }
  })
  const [filter, setFilter] = useState<FindingFilter>(DEFAULT_FILTER)
  const [starting, setStarting] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [listKey, setListKey] = useState(0)
  const [about, setAbout] = useState(false)
  const data = summary.data
  const running = starting || data?.running === true || data?.lastScan?.status === 'running'
  useLiveRefresh(visible, summary.reload)
  useEffect(() => {
    if (!running || !visible) return
    const timer = setInterval(summary.reload, SCAN_POLL_MS)
    return () => clearInterval(timer)
  }, [running, visible, summary.reload])
  const changed = (): void => { summary.reload(); counts.reload() }
  // A scan that just ended changed the findings: reload the list and the counts once.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) { setListKey((k) => k + 1); counts.reload() }
    wasRunning.current = running
  }, [running, counts.reload])
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

  const state = isOff(summary.code) ? <Off />
    : isGone(summary.code) ? <p role="alert" className="ccp-error">{HL.gone}</p>
    : summary.loading && !data ? <p role="status">{HL.loading}</p>
    : !data ? <Failed text={summary.error ?? HL.loadFailed} onRetry={summary.reload} />
    : null
  if (state || !data) return <><div className="health-header">{picker}</div>{state}</>
  const last = data.lastScan
  const done = last?.status === 'done' ? last : null
  const ctx: RowContext = { client, projectName: project.name, ...(project.root ? { root: project.root } : {}), onChanged: changed }
  return (
    <>
      <div className="health-header">
        {picker}
        <span className="health-summary">{HL.summary(data.open, done && relativeTime(done.finishedAt ?? done.startedAt), done && done.filesScanned)}</span>
        {last?.truncated && <span className="ccp-badge ccp-badge--warn">{HL.partial}</span>}
        <span className="health-actions">
          <Button type="button" size="sm" disabled={running} aria-busy={running} onClick={() => void scan()}>
            {running && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}{running ? HL.scanning : HL.scanNow}
          </Button>
          <HealthAnalysis client={client} projectId={projectId} visible={visible} onFinished={() => { setListKey((k) => k + 1); changed() }} />
          <IconButton type="button" size="icon-sm" label={HL.about} aria-expanded={about} aria-controls="health-about" onClick={() => setAbout((a) => !a)}><span className="codicon codicon-info" aria-hidden="true" /></IconButton>
        </span>
      </div>
      {about && (
        <div id="health-about" role="note" className="health-about">
          <p>{HL.intro}</p>
          <p>{HL.analyzeCost}</p>
          {last?.truncated && <p>{HL.partialHint}</p>}
        </div>
      )}
      {summary.error && <Failed text={summary.error} onRetry={summary.reload} />}
      {scanError && <p role="alert" className="ccp-error">{scanError}</p>}
      {!running && last?.status === 'failed' && <p role="alert" className="ccp-error">{isNoRepoError(last.error) ? HL.noRepo : HL.lastScanFailed(last.error)}</p>}
      {!last && !running ? (
        <div className="health-cta">
          <p>{HL.neverScanned}</p>
          <Button type="button" size="sm" onClick={() => void scan()}>{HL.runScan}</Button>
        </div>
      ) : (
        <>
          <Filters filter={filter} onChange={setFilter} summary={data} counts={{ open: NUMBER.format(data.open), ...counts.data }} />
          {/* A changed filter or finished scan is a different list: the key drops old rows and any in-flight page. */}
          <Findings key={`${filter.status}-${filter.severity}-${filter.rule}-${filter.origin}-${listKey}`} ctx={ctx} projectId={projectId} filter={filter} lastScanAt={last?.finishedAt ?? null} />
        </>
      )}
    </>
  )
}

export default function HealthView({ client = healthApi, visible = true }: { client?: HealthClient; visible?: boolean }) {
  const projects = useLoad((signal) => client.listProjects(signal))
  const [picked, setPicked] = useState(remembered)
  const list = projects.data ?? []
  const project = list.find((p) => p.id === picked) ?? list[0]
  return (
    <section className="ccp-section health" aria-labelledby="ccp-health-h">
      <h3 id="ccp-health-h" className="sr-only">{HL.heading}</h3>
      {isOff(projects.code) ? <Off /> : (
        <>
          {projects.loading && !projects.data && <p role="status">{HL.loading}</p>}
          {projects.error && !projects.data && <Failed text={projects.error} onRetry={projects.reload} />}
          {projects.data && list.length === 0 && <p>{HL.noProjects}</p>}
          {project && (
            <HealthBody key={project.id} client={client} project={project} visible={visible} picker={
              <Select value={project.id} onValueChange={(id) => { setPicked(id); remember(id) }}>
                <SelectTrigger size="sm" aria-label={HL.project} className="health-project"><SelectValue /></SelectTrigger>
                <SelectContent>{list.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            } />
          )}
        </>
      )}
    </section>
  )
}
