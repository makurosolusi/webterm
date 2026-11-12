// Central's memory: the working state it reads each turn and what it remembers, with where each item came from.
// Values that look like secrets are never rendered (defense in depth: the server already redacts, this only guards a miss).
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useState } from 'react'
import { relativeTime } from '../SessionHistory.model'
import { openCentralSettings } from './LevelPanel'
import { MemoryWorkingState } from './MemoryWorkingState'
import { CL, SOURCE_LABEL, TRUST_LABEL } from './centralLabels'
import { centralControlApi } from './centralControlApi'
import type { CentralControlClient, MemoryFilter, MemoryRow } from './centralControlTypes'
import { centralErrorMessage, useLoad, usePaged } from './centralLoad'
import './central.css'

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|ghp|gho|xox[bp]|AKIA)[-_A-Za-z0-9]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S{6,}/i,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/,
]

/** True when a memory value resembles a credential and must not be displayed. */
export function looksSecret(value: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(value))
}

/** Select value for "no filter" (Radix Select has no empty value). */
const ALL = 'all'
const TASK_PREFIX = 'task:'
const NOT_RUNNING = 'http_404'

const isOff = (code: string | null): boolean => code !== null && (code.endsWith('_off') || code === NOT_RUNNING)
const linkedTask = (m: MemoryRow): string | null => (m.sourceKind === 'task' ? m.sourceRef : m.sourceRef?.startsWith(TASK_PREFIX) ? m.sourceRef.slice(TASK_PREFIX.length) : null)
const BUSY = { confirm: 'Confirming…', forget: 'Forgetting…' } as const

const sourceOf = (m: MemoryRow): string | null => (m.sourceKind ? CL.memorySource(SOURCE_LABEL[m.sourceKind] ?? m.sourceKind) : null)

function MemoryItem({ row, client }: { row: MemoryRow; client: CentralControlClient }) {
  const [confirmed, setConfirmed] = useState(false)
  const [forgotten, setForgotten] = useState(false)
  const [asking, setAsking] = useState(false)
  const failure = (err: unknown) => centralErrorMessage(err, CL.actionFailed)
  const confirm = useAction(async () => { await client.confirmMemory(row.id); setConfirmed(true) }, { label: CL.memoryConfirm, failure })
  const forget = useAction(async () => { await client.forgetMemory(row.id); setForgotten(true) }, { label: CL.memoryForget, failure })
  const busy = confirm.busy || forget.busy
  if (forgotten) return <li className="ccp-row"><span className="ccp-row__meta" role="status">{CL.memoryForgotten}</span></li>
  const masked = looksSecret(row.value) || looksSecret(row.key)
  const name = masked ? row.id : row.key
  const task = linkedTask(row)
  const meta = [row.kind, row.projectName || CL.stateGlobal, sourceOf(row), task && CL.memoryTask(task), relativeTime(row.createdAt)].filter(Boolean).join(' · ')
  return (
    <li className="ccp-row" aria-busy={busy}>
      <span className="ccp-row__main ccp-memory__text">{masked ? <em>{CL.secretMasked}</em> : row.value}</span>
      <span className="ccp-badge">{confirmed ? TRUST_LABEL.human : TRUST_LABEL[row.trust] ?? row.trust}</span>
      <span className="ccp-row__meta">{meta}</span>
      <span className="ccp-row__actions">
        {row.status === 'claim' && row.trust !== 'external' && !confirmed && <ActionButton type="button" size="sm" aria-label={CL.memoryConfirmLabel(name)} disabled={busy} action={confirm} busyLabel={BUSY.confirm}>{CL.memoryConfirm}</ActionButton>}
        <Button type="button" size="sm" variant="secondary" aria-label={CL.memoryForgetLabel(name)} disabled={busy || asking} onClick={() => setAsking(true)}>{CL.memoryForget}</Button>
      </span>
      {asking && (
        <div role="alertdialog" aria-modal="false" aria-label={CL.memoryForgetLabel(name)} className="ccp-confirm">
          <p>{CL.memoryForgetPrompt}</p>
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setAsking(false)}>{CL.memoryForgetCancel}</Button>
          <ActionButton type="button" size="sm" variant="destructive" disabled={busy} action={forget} busyLabel={BUSY.forget}>{CL.memoryForgetConfirm}</ActionButton>
        </div>
      )}
      <ActionResult action={confirm} />
      <ActionResult action={forget} />
    </li>
  )
}

function Remembered({ client, filter, filtered }: { client: CentralControlClient; filter: MemoryFilter; filtered: boolean }) {
  const list = usePaged((offset, signal) => client.listMemory(offset, signal, filter))
  return (
    <>
      {list.error && <p role="alert" className="ccp-error">{list.error}</p>}
      {list.loading && list.items.length === 0 && <p role="status">{CL.loading}</p>}
      {!list.loading && !list.error && list.items.length === 0 && <p>{filtered ? CL.memoryNoMatch : CL.memoryEmpty}</p>}
      {list.items.length > 0 && <ul className="ccp-list" aria-label={CL.rememberedHeading}>{list.items.map((m) => <MemoryItem key={m.id} row={m} client={client} />)}</ul>}
      {list.hasMore && <Button type="button" size="sm" variant="secondary" onClick={list.loadMore}>{CL.loadMore}</Button>}
    </>
  )
}

export default function MemoryView({ client = centralControlApi }: { client?: CentralControlClient }) {
  const [project, setProject] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const projects = useLoad((signal) => client.listBoardNodes(0, undefined, signal).then((page) => page.projects))
  const projectId = project === ALL ? undefined : project
  // The key reloads the documents for the picked project; old ones never show under a new name.
  return (
    <section className="ccp-section" aria-labelledby="ccp-mem-h">
      <h3 id="ccp-mem-h">{CL.memoryHeading}</h3>
      <p>{CL.memoryIntro}</p>
      <div className="ccp-filters">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger aria-label={CL.projectFilter}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{CL.allProjects}</SelectItem>
            {projects.data?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <MemoryBody key={project} client={client} project={projects.data?.find((p) => p.id === projectId) ?? null} projectId={projectId} status={status} onStatus={setStatus} />
    </section>
  )
}

interface BodyProps { client: CentralControlClient; project: { id: string; name: string } | null; projectId: string | undefined; status: string; onStatus: (s: string) => void }

function MemoryBody({ client, project, projectId, status, onStatus }: BodyProps) {
  const state = useLoad((signal) => client.getWorkingState(projectId, signal))
  if (isOff(state.code)) {
    return (
      <div className="ccp-off" data-central-off="memory">
        <p>{CL.memoryOff}</p>
        <Button type="button" size="sm" variant="secondary" onClick={() => openCentralSettings('central')}>{CL.memoryOpenSettings}</Button>
      </div>
    )
  }
  const filter: MemoryFilter = { ...(projectId ? { projectId } : {}), ...(status === ALL ? {} : { status: status as 'claim' | 'fact' }) }
  return (
    <>
      <MemoryWorkingState state={state} project={project} client={client} />
      <h3>{CL.rememberedHeading}</h3>
      <div className="ccp-filters">
        <Select value={status} onValueChange={onStatus}>
          <SelectTrigger aria-label={CL.statusFilter}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{CL.statusAll}</SelectItem>
            <SelectItem value="fact">{CL.statusConfirmed}</SelectItem>
            <SelectItem value="claim">{CL.statusUnverified}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {/* A changed filter is a different list: the key drops the old rows and any in-flight page. */}
      <Remembered key={status} client={client} filter={filter} filtered={projectId !== undefined || status !== ALL} />
    </>
  )
}
