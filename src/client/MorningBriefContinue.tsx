// "Continue from yesterday" (F5-c): per workspace, one click or one ⌘K command hands every agent that ran
// there its handoff card (server: src/server/handoff), then opens the workspace so the agents resume with
// the card injected. Shown inside the morning brief card; the commands stay registered when it is hidden.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HandoffCard } from '../server/handoff/handoff.model'
import { Button } from '@/components/ui/button'
import { useRegisterCommands, type Command } from './commandRegistry'
import { request } from './inboxTransport'

export const HANDOFF_PATH = '/api/handoff'
export const HANDOFF_CONTINUE_PATH = `${HANDOFF_PATH}/continue`

export interface HandoffAgent { nodeId: string; title: string; card: HandoffCard | null }
export interface HandoffWorkspace { id: string; name: string; agents: HandoffAgent[] }
interface ContinueReply { results: Array<{ nodeId: string; injected: boolean; skipped?: string }> }

/** Loads the workspaces with resumable agents and registers one ⌘K command per workspace. */
export function useContinue(onOpenWorkspace?: (workspaceId: string) => void) {
  const [workspaces, setWorkspaces] = useState<HandoffWorkspace[]>([])
  const [status, setStatus] = useState<Record<string, string>>({})
  // Parents pass an inline arrow; a ref keeps `resume` (and the registered commands) stable across their renders,
  // otherwise every render re-registers the commands, which re-renders the parent: an update loop.
  const openRef = useRef(onOpenWorkspace)
  openRef.current = onOpenWorkspace

  const load = useCallback((): void => {
    request<{ workspaces: HandoffWorkspace[] }>(HANDOFF_PATH).then((r) => setWorkspaces(r.workspaces), (err: unknown) => {
      console.warn('[handoff] GET /api/handoff failed', err) // ledger off / offline: no Continue entry
    })
  }, [])
  useEffect(load, [load])

  const resume = useCallback((ws: HandoffWorkspace): void => {
    setStatus((s) => ({ ...s, [ws.id]: 'Preparing handoff cards…' }))
    request<ContinueReply>(HANDOFF_CONTINUE_PATH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: ws.id }),
    }).then((r) => {
      const sent = r.results.filter((x) => x.injected).length
      setStatus((s) => ({ ...s, [ws.id]: sent > 0 ? `Handed off to ${sent} agent${sent === 1 ? '' : 's'}` : 'Agents already have their cards' }))
      openRef.current?.(ws.id)
      load()
    }, (err: unknown) => {
      console.warn('[handoff] POST /api/handoff/continue failed', err)
      setStatus((s) => ({ ...s, [ws.id]: 'Could not prepare the handoff' }))
    })
  }, [load])

  const commands = useMemo<Command[]>(() => workspaces.map((ws) => ({
    id: `handoff.continue.${ws.id}`, label: `Agents: Continue from yesterday in ${ws.name}`, run: () => resume(ws),
  })), [workspaces, resume])
  useRegisterCommands(commands)

  return { workspaces, status, resume }
}

export function ContinueSection({ workspaces, status, resume }: ReturnType<typeof useContinue>): React.JSX.Element | null {
  if (workspaces.length === 0) return null
  return (
    <div className="morning-brief__group" data-category="continue">
      <h4>Continue from yesterday</h4>
      {workspaces.map((ws) => (
        <div key={ws.id} className="morning-brief__continue">
          <div className="morning-brief__continue-head">
            <span>{ws.name}</span>
            <Button variant="outline" size="xs" onClick={() => resume(ws)} aria-label={`Continue from yesterday in ${ws.name}`}>Continue</Button>
          </div>
          {status[ws.id] && <p className="morning-brief__status" role="status">{status[ws.id]}</p>}
          <ul>
            {ws.agents.map((a) => (
              <li key={a.nodeId} title={a.card ? `Card from ${new Date(a.card.createdAt).toLocaleString()}` : 'No card yet: one is written on Continue'}>
                <span><strong>{a.title}</strong>{a.card ? ` — ${a.card.narrative.summary}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
