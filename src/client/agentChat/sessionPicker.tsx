// Conversation history of the agent chat footer (Claude Code VS Code "Past conversations").
import { useState } from 'react'
import { Popover } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { portalContainer } from '@/components/vscode/portalContainer'
import type { AgentChatSessionSummary } from '../../shared/agentChat.wire'
import { relativeTime } from '../SessionHistory.model'
import { errorText } from './toolCards'
import './agentChatToolbar.css'

export interface SessionPickerProps {
  /** Past conversations of the node's folder; fetched each time the list opens. */
  loadSessions: () => Promise<AgentChatSessionSummary[]>
  onResume: (sessionId: string) => Promise<void>
  onNew: () => Promise<void>
  disabled?: boolean
  /** Icon-only trigger for narrow nodes. */
  compact?: boolean
}

/** "History" popover: search, New conversation, resume a past one; closes once the action succeeds. */
export function SessionPicker({ loadSessions, onResume, onNew, disabled, compact }: SessionPickerProps) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string>() // sessionId being resumed, or 'new'
  const [actionError, setActionError] = useState<string>()

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try { setSessions(await loadSessions()) } catch (e) { setError(errorText(e)) } finally { setLoading(false) }
  }
  const openChange = (next: boolean): void => {
    setOpen(next)
    if (!next) return
    setQuery('')
    setActionError(undefined)
    void load()
  }
  const act = async (key: string, what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setActionError(undefined)
    try { await fn(); setOpen(false) } catch (e) { setActionError(`Could not ${what}: ${errorText(e)}`) } finally { setBusy(undefined) }
  }
  const q = query.trim().toLowerCase()
  const shown = sessions?.filter((s) => s.title.toLowerCase().includes(q))

  return (
    <Popover.Root open={open} onOpenChange={openChange}>
      <IconTooltip label="Conversation history" disabled={disabled}>
        <Popover.Trigger asChild disabled={disabled}>
          <button type="button" className="act-trigger" aria-label="Conversation history">
            <span className="codicon codicon-history" aria-hidden="true" />
            {!compact && <span className="act-trigger__label">History</span>}
          </button>
        </Popover.Trigger>
      </IconTooltip>
      <Popover.Portal container={portalContainer()}>
        <Popover.Content className="act-menu act-sessions" side="top" align="start" sideOffset={4} aria-label="Conversation history">
          <div className="act-sessions__bar">
            <Input className="act-sessions__search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations" aria-label="Search conversations" autoFocus />
            <Button variant="secondary" size="xs" disabled={!!busy} onClick={() => void act('new', 'start a new conversation', onNew)}>
              <span className={`codicon ${busy === 'new' ? 'codicon-loading codicon-modifier-spin' : 'codicon-add'}`} aria-hidden="true" />
              New conversation
            </Button>
          </div>
          {actionError && <p className="act-menu__note act-menu__note--error" role="alert">{actionError}</p>}
          {loading && <p className="act-menu__note" role="status">Loading conversations…</p>}
          {error && !loading && (
            <p className="act-menu__note act-menu__note--error" role="alert">
              {`Could not load conversations: ${error} `}
              <Button variant="secondary" size="xs" onClick={() => void load()}>Retry</Button>
            </p>
          )}
          {shown && !loading && !error && shown.length === 0 && (
            <p className="act-menu__note">{sessions!.length === 0 ? 'No past conversations yet' : 'No matching conversations'}</p>
          )}
          {shown && !loading && !error && shown.length > 0 && (
            <ul className="act-sessions__list" aria-label="Past conversations">
              {shown.map((s) => (
                <li key={s.sessionId}>
                  <button type="button" className="act-menu__item act-sessions__item" disabled={s.current || !!busy}
                    aria-current={s.current || undefined} onClick={() => void act(s.sessionId, 'resume the conversation', () => onResume(s.sessionId))}>
                    <span className="act-sessions__title">{s.title || 'Untitled conversation'}</span>
                    <span className="act-menu__desc">
                      {busy === s.sessionId ? 'Resuming…' : s.current ? `Current · ${relativeTime(s.updatedAt)}` : relativeTime(s.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
