// Sticky todo list of the agent chat (latest TodoWrite input), placed above the composer by the view.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentChatTodo } from '../../shared/agentChat.wire'
import './agentChatTimeline.css'

const ICON: Record<AgentChatTodo['status'], string> = {
  pending: 'circle-large-outline', in_progress: 'loading codicon-modifier-spin', completed: 'pass-filled',
}
const STATUS_LABEL: Record<AgentChatTodo['status'], string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' }

/** Collapsible "Todos n/m" panel; renders nothing when Claude has not written a todo list. */
export function TodoPanel({ todos }: { todos: AgentChatTodo[] }) {
  const [open, setOpen] = useState(true)
  if (todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  return (
    <section className="act-todos" aria-label="Todo list">
      <Button variant="ghost" className="act-todos__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
        <span className="act-todos__title">Todos</span>
        <span className="act-todos__progress" aria-label={`${done} of ${todos.length} done`}>{`${done}/${todos.length}`}</span>
        {!open && current && <span className="act-todos__current">{current.activeForm || current.content}</span>}
      </Button>
      {open && (
        <ul className="act-todos__list">
          {todos.map((t, n) => (
            <li key={n} className="act-todos__item" data-status={t.status}>
              <span className={`codicon codicon-${ICON[t.status]}`} role="img" aria-label={STATUS_LABEL[t.status]} />
              <span className="act-todos__text">{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
