// Agents on the phone: status + last thing each one said, and "Send prompt" through the server
// outbox (`POST /api/outbox`, the path Diff notes use), so a prompt waits until the agent is idle
// and a retried tap is delivered once (same operationId).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Textarea } from '@/components/ui/textarea'
import type { MobileAgent } from '../../server/push/mobileAgents'
import { OUTBOX_PATH, type OutboxEnqueueReply } from '../../server/outbox/outbox.types'
import { inboxErrorMessage } from '../inboxApi'
import { request } from '../inboxTransport'
import { usePoll } from './mobile.poll'

export const MOBILE_AGENTS_PATH = '/api/mobile/agents'
const STATUS_LABEL: Record<string, string> = { working: 'Working', waiting: 'Needs input', blocked: 'Needs approval', done: 'Done' }

export function sendPrompt(nodeId: string, text: string, operationId: string): Promise<OutboxEnqueueReply> {
  return request<OutboxEnqueueReply>(OUTBOX_PATH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: nodeId, body: text, operationId }),
  })
}

const newOperationId = (nodeId: string): string => `mobile:${nodeId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function AgentCard({ agent }: { agent: MobileAgent }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [op, setOp] = useState(() => newOperationId(agent.nodeId))
  const status = agent.status ? STATUS_LABEL[agent.status] ?? agent.status : agent.live ? 'Idle' : 'Not running'

  // A failure keeps the text and the operationId, so Retry delivers this prompt once.
  const submit = useAction(async () => {
    const r = await sendPrompt(agent.nodeId, text.trim(), op)
    setText('')
    setOp(newOperationId(agent.nodeId)) // the next prompt is a new operation; a retry of this one is not
    setOpen(false)
    return r
  }, {
    label: `Send prompt to ${agent.title}`,
    success: (r) => (r.message.status === 'delivered' ? 'Sent.' : 'Queued: delivered when the agent is idle.'),
    failure: (err) => `Could not send: ${inboxErrorMessage(err)}`,
  })

  return (
    <article className="m-card">
      <div className="m-agent-head">
        <h3 className="m-card-title">{agent.title}</h3>
        <span className={`m-status m-status-${agent.status ?? (agent.live ? 'idle' : 'off')}`}>{status}</span>
      </div>
      <p className="m-card-meta">{agent.workspace} · {agent.agentId}</p>
      {agent.lastMessage && <p className="m-card-body">{agent.lastMessage}</p>}
      {open ? (
        <div className="m-reply">
          <Textarea aria-label={`Prompt for ${agent.title}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          <div className="m-actions">
            <ActionButton type="button" className="m-btn m-primary" disabled={!text.trim()} action={submit} busyLabel="Sending…">Send</ActionButton>
            <Button type="button" className="m-btn" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="m-actions"><Button type="button" className="m-btn" onClick={() => setOpen(true)}>Send prompt</Button></div>
      )}
      <ActionResult action={submit} />
    </article>
  )
}

export function MobileAgents(props: { pollMs?: number }): React.JSX.Element {
  const { data, error } = usePoll(() => request<{ agents: MobileAgent[] }>(MOBILE_AGENTS_PATH), props.pollMs ?? 5000)
  return (
    <section className="m-screen" aria-label="Agents">
      {error && <p className="m-error" role="alert">{error}</p>}
      {data && data.agents.length === 0 && <p className="m-empty">No agents on any board.</p>}
      {data?.agents.map((a) => <AgentCard key={a.nodeId} agent={a} />)}
    </section>
  )
}
