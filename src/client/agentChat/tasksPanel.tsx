// "Tasks" list of the agent chat: subagents and background shells of the conversation (server `task`
// events from the SDK task_* messages), with Stop on a running one (SDK Query.stopTask). Sits above the
// composer next to the todo panel and reuses its look; the subagent's own tool calls stay in its Task card.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import type { AgentChatTask } from '../../shared/agentChat.wire'
import './agentChatTimeline.css'

const ICON: Record<AgentChatTask['status'], string> = {
  running: 'loading codicon-modifier-spin', completed: 'pass-filled', failed: 'error', stopped: 'circle-slash',
}
const STATUS_LABEL: Record<AgentChatTask['status'], string> = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' }

export interface TasksPanelProps {
  tasks: Record<string, AgentChatTask>
  /** Rejects with a user-facing message when the task could not be stopped. */
  onStop: (taskId: string) => Promise<void>
}

/** Collapsible "Tasks n running" panel; nothing until Claude starts a task. */
export function TasksPanel({ tasks, onStop }: TasksPanelProps) {
  const [open, setOpen] = useState(true)
  const [stopping, setStopping] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const list = Object.values(tasks)
  if (list.length === 0) return null
  const running = list.filter((t) => t.status === 'running').length
  const stop = (id: string): void => {
    setError(null)
    setStopping((s) => ({ ...s, [id]: true }))
    onStop(id).then(
      () => setStopping((s) => ({ ...s, [id]: false })),
      (err: unknown) => { setStopping((s) => ({ ...s, [id]: false })); setError(err instanceof Error ? err.message : String(err)) },
    )
  }
  return (
    <section className="act-todos act-tasks" aria-label="Tasks">
      <Button variant="ghost" className="act-todos__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
        <span className="act-todos__title">Tasks</span>
        <span className="act-todos__progress">{running > 0 ? `${running} running` : `${list.length} done`}</span>
      </Button>
      {open && (
        <ul className="act-todos__list">
          {list.map((t) => (
            <li key={t.id} className="act-todos__item act-tasks__item" data-status={t.status}>
              <span className={`codicon codicon-${ICON[t.status]}`} role="img" aria-label={STATUS_LABEL[t.status]} />
              <span className="act-todos__text">
                {t.description}
                {(t.summary || t.lastTool) && <span className="act-tasks__detail">{t.summary ?? `Running ${t.lastTool}`}</span>}
              </span>
              {t.status === 'running' && (
                <IconButton label={`Stop task ${t.description}`} tooltip="Stop this task" size="icon-xs" disabled={stopping[t.id]} onClick={() => stop(t.id)}>
                  <span className="codicon codicon-debug-stop" aria-hidden="true" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="act-tasks__error" role="alert">{`Could not stop the task: ${error}`}</p>}
    </section>
  )
}
