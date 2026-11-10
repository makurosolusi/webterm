// Agents tab: Central-managed workers (live by default, with relay/close) and the Claude nodes the user
// opened on any board. Relay/close may come back as an approval request (R2 on a user-owned agent); the
// decision itself happens in the Central chat's Needs-you list.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useState } from 'react'
import { AGENT_TERMINAL_STATES } from '../../server/central/contracts/agent.types'
import { CapabilityOffer } from '../CapabilityOffer'
import { focusCanvasNode } from '../osNotify'
import { relativeTime } from '../SessionHistory.model'
import { CL } from './centralLabels'
import { AGENTS_OFF, CENTRAL_PAGE_SIZE, centralControlApi } from './centralControlApi'
import type { AgentAction, AgentRow, BoardNodeRow, CentralControlClient } from './centralControlTypes'
import { centralErrorMessage, useLiveRefresh, usePaged, type Paged } from './centralLoad'
import { refreshNeedsYou } from '../chat/needsYouApi'

export interface AgentListProps {
  client?: CentralControlClient
  /** False while the panel sits mounted behind another view. */
  visible?: boolean
}

/** Select value for "no project filter" (Radix Select has no empty value). */
const ALL_PROJECTS = 'all'
const isTerminal = (state: string): boolean => (AGENT_TERMINAL_STATES as readonly string[]).includes(state)

// ponytail: auto-refresh stops once "Load more" was used, because a reload returns page one; refetch every loaded page if that matters.
function useFirstPageRefresh<T>(visible: boolean, list: Paged<T>): void {
  useLiveRefresh(visible, () => { if (list.items.length <= CENTRAL_PAGE_SIZE) list.reload() })
}

function OpenNode({ nodeId, label, gone }: { nodeId: string; label: string; gone?: boolean }) {
  return (
    <>
      <Button type="button" size="sm" variant="secondary" disabled={gone} aria-label={`${CL.openNode} ${label}`} onClick={() => focusCanvasNode(nodeId)}>{CL.openNode}</Button>
      {gone && <span className="ccp-row__meta">{CL.nodeGone}</span>}
    </>
  )
}

interface WorkersProps { client: CentralControlClient; visible: boolean; projectId: string | undefined; showFinished: boolean; onShowFinished: (on: boolean) => void }

function Workers({ client, visible, projectId, showFinished, onShowFinished }: WorkersProps) {
  const agents = usePaged((offset, signal) => client.listAgents(offset, signal, { live: !showFinished, projectId }))
  useFirstPageRefresh(visible, agents)
  const [relayFor, setRelayFor] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const off = agents.code === AGENTS_OFF

  const run = async (row: AgentRow, action: AgentAction, message?: string) => {
    try {
      const res = await client.agentAction(row.id, action, message)
      if (res.status === 'needs_approval') {
        setNote({ ok: true, text: CL.approvalRequested })
        void refreshNeedsYou()
      } else {
        setNote({ ok: true, text: CL.actionDone })
        agents.reload()
      }
      setRelayFor(null)
      setText('')
    } catch (err) {
      setNote({ ok: false, text: centralErrorMessage(err, CL.actionFailed) })
    }
  }

  // Agents off: the worker orchestrator card turns them on; Central restarts itself, no server restart.
  if (off) return <div className="ccp-off" data-central-off="agents"><p>{CL.agentsOff}</p><CapabilityOffer id="workers" onDone={agents.reload} /></div>
  return (
    <>
      <div className="ccp-filters">
        <label htmlFor="ccp-show-finished"><Switch id="ccp-show-finished" checked={showFinished} onCheckedChange={onShowFinished} />{CL.showFinished}</label>
      </div>
      {agents.error && <p role="alert" className="ccp-error">{agents.error}</p>}
      {agents.loading && agents.items.length === 0 && <p role="status">{CL.loading}</p>}
      {!agents.loading && !agents.error && agents.items.length === 0 && <p>{showFinished ? CL.empty : CL.agentsNoneLive}</p>}
      <ul className="ccp-list" aria-label={CL.agentsHeading}>
        {agents.items.map((a) => (
          <li key={a.id} className="ccp-row">
            <span className="ccp-row__main"><strong>{a.kind}</strong> <span>{a.role}</span> <span data-testid={`state-${a.id}`}>{a.state}</span></span>
            <span className="ccp-row__meta">{a.projectName || a.projectId} · {CL.agentOwner}: {a.owner} · {CL.agentRunner}: {a.runner}{a.startedAt ? ` · ${CL.agentStarted(relativeTime(a.startedAt))}` : ''}</span>
            <span className="ccp-row__actions">
              {a.nodeId && <OpenNode nodeId={a.nodeId} label={a.id} gone={!a.nodeOnBoard} />}
              {!isTerminal(a.state) && (
                <>
                  <Button type="button" size="sm" variant="secondary" aria-label={`${CL.relay} ${a.id}`} onClick={() => { setRelayFor(relayFor === a.id ? null : a.id); setNote(null) }}>{CL.relay}</Button>
                  <Button type="button" size="sm" variant="secondary" aria-label={`${CL.close} ${a.id}`} onClick={() => void run(a, 'close')}>{CL.close}</Button>
                </>
              )}
            </span>
            {relayFor === a.id && (
              <form className="ccp-relay" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(a, 'relay', text.trim()) }}>
                <Input aria-label={CL.relayPrompt} placeholder={CL.relayPrompt} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
                <Button type="submit" size="sm">{CL.relaySend}</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? undefined : 'ccp-error'}>{note.text}</p>}
      {agents.hasMore && <Button type="button" size="sm" variant="secondary" onClick={agents.loadMore}>{CL.loadMore}</Button>}
    </>
  )
}

const nodeStatus = (n: BoardNodeRow): string => (n.live ? n.status ?? CL.nodeRunning : CL.nodeNotRunning)

interface BoardProps { client: CentralControlClient; visible: boolean; projectId: string | undefined; onProjects: (projects: Array<{ id: string; name: string }>) => void }

function BoardNodes({ client, visible, projectId, onProjects }: BoardProps) {
  const nodes = usePaged(async (offset, signal) => {
    const page = await client.listBoardNodes(offset, projectId, signal)
    onProjects(page.projects)
    return page.items
  })
  useFirstPageRefresh(visible, nodes)
  return (
    <>
      <h3 id="ccp-board-h">{CL.boardHeading}</h3>
      {nodes.error && <p role="alert" className="ccp-error">{nodes.error}</p>}
      {nodes.loading && nodes.items.length === 0 && <p role="status">{CL.loading}</p>}
      {!nodes.loading && !nodes.error && nodes.items.length === 0 && <p>{CL.boardEmpty}</p>}
      <ul className="ccp-list" aria-labelledby="ccp-board-h">
        {nodes.items.map((n) => (
          <li key={`${n.workspaceId}:${n.nodeId}`} className="ccp-row">
            <span className="ccp-row__main"><strong>{n.title}</strong> <span data-testid={`node-status-${n.nodeId}`}>{nodeStatus(n)}</span></span>
            <span className="ccp-row__meta">{n.projectName}</span>
            <span className="ccp-row__actions"><OpenNode nodeId={n.nodeId} label={n.title} /></span>
          </li>
        ))}
      </ul>
      {nodes.hasMore && <Button type="button" size="sm" variant="secondary" onClick={nodes.loadMore}>{CL.loadMore}</Button>}
    </>
  )
}

export default function AgentList({ client = centralControlApi, visible = true }: AgentListProps) {
  const [showFinished, setShowFinished] = useState(false)
  const [project, setProject] = useState(ALL_PROJECTS)
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const projectId = project === ALL_PROJECTS ? undefined : project
  return (
    <section className="ccp-section" aria-labelledby="ccp-agents-h">
      <h3 id="ccp-agents-h">{CL.agentsHeading}</h3>
      <div className="ccp-filters">
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger aria-label={CL.projectFilter}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>{CL.allProjects}</SelectItem>
            {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {/* A changed filter is a different list: the key drops the old rows and any in-flight page. */}
      <Workers key={`${project}-${showFinished}`} client={client} visible={visible} projectId={projectId} showFinished={showFinished} onShowFinished={setShowFinished} />
      <BoardNodes key={project} client={client} visible={visible} projectId={projectId} onProjects={setProjects} />
    </section>
  )
}
