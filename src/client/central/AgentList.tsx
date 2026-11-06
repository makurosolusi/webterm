// Central-managed agents with relay/close. Both actions may come back as an approval request
// (R2 on a user-owned agent); the decision itself happens in the Approvals tab.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { CapabilityOffer } from '../CapabilityOffer'
import { CL } from './centralLabels'
import { AGENTS_OFF, centralControlApi } from './centralControlApi'
import type { AgentAction, AgentRow, CentralControlClient } from './centralControlTypes'
import { centralErrorMessage, usePaged } from './centralLoad'

export interface AgentListProps {
  client?: CentralControlClient
  /** Called when an action became an approval, so the host can refresh the Approvals tab. */
  onApprovalRequested?: () => void
}

export default function AgentList({ client = centralControlApi, onApprovalRequested }: AgentListProps) {
  const agents = usePaged((offset, signal) => client.listAgents(offset, signal))
  const [relayFor, setRelayFor] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const off = agents.code === AGENTS_OFF

  const run = async (row: AgentRow, action: AgentAction, message?: string) => {
    try {
      const res = await client.agentAction(row.id, action, message)
      if (res.status === 'needs_approval') {
        setNote({ ok: true, text: CL.approvalRequested })
        onApprovalRequested?.()
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

  return (
    <section className="ccp-section" aria-labelledby="ccp-agents-h">
      <h3 id="ccp-agents-h">{CL.agentsHeading}</h3>
      {/* Agents off: the worker orchestrator card turns them on; Central restarts itself, no server restart. */}
      {off && <div className="ccp-off" data-central-off="agents"><p>{CL.agentsOff}</p><CapabilityOffer id="workers" onDone={agents.reload} /></div>}
      {agents.error && !off && <p role="alert" className="ccp-error">{agents.error}</p>}
      {agents.loading && agents.items.length === 0 && <p role="status">{CL.loading}</p>}
      {!agents.loading && !agents.error && agents.items.length === 0 && <p>{CL.empty}</p>}
      <ul className="ccp-list" aria-label={CL.agentsHeading}>
        {agents.items.map((a) => (
          <li key={a.id} className="ccp-row">
            <span className="ccp-row__main"><strong>{a.kind}</strong> <span>{a.role}</span> <span data-testid={`state-${a.id}`}>{a.state}</span></span>
            <span className="ccp-row__meta">{CL.agentOwner}: {a.owner} · {CL.agentRunner}: {a.runner}</span>
            <span className="ccp-row__actions">
              <Button type="button" size="sm" variant="secondary" aria-label={`${CL.relay} ${a.id}`} onClick={() => { setRelayFor(relayFor === a.id ? null : a.id); setNote(null) }}>{CL.relay}</Button>
              <Button type="button" size="sm" variant="secondary" aria-label={`${CL.close} ${a.id}`} onClick={() => void run(a, 'close')}>{CL.close}</Button>
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
    </section>
  )
}
