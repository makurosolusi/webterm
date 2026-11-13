// The Plan node's mini-graph: one column per wave (what may run together), one card per task with its
// dependencies, lease and effort; gate tasks are marked as human decisions. Live statuses once approved.
import { ToolbarButton } from '@/vscode/register'
import { IconTooltip } from '@/components/ui/icon-button'
import type { PlanTaskData } from '../shared/workspace'
import type { TaskStatus } from './PlanNode.model'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export interface PlanGraphProps {
  tasks: readonly PlanTaskData[]
  waves: readonly string[][]
  status?: Record<string, TaskStatus>
  /** Present while the plan is a draft: the card offers to drop the task. */
  onRemove?: (key: string) => void
}

export function PlanGraph({ tasks, waves, status, onRemove }: PlanGraphProps) {
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  return (
    <ol className="plan-node__waves" aria-label="Plan waves">
      {waves.map((wave, i) => (
        <li key={i} className="plan-node__wave">
          <div className="plan-node__wave-head">Wave {i + 1}</div>
          <ul className="plan-node__tasks">
            {wave.map((key) => {
              const t = byKey.get(key)
              if (!t) return null
              const st = status?.[key]
              const lease = list(t.brief['lease'])
              return (
                <li key={key} className={`plan-node__task${t.kind === 'gate' ? ' plan-node__task--gate' : ''}${st ? ` plan-node__task--${st}` : ''}`} aria-label={`Task ${key}`}>
                  <div className="plan-node__task-head">
                    <span className={`codicon codicon-${t.kind === 'gate' ? 'question' : 'circuit-board'}`} aria-hidden="true" />
                    <strong>{key}</strong>
                    {t.kind === 'gate' ? <span className="plan-node__badge">Your decision</span> : <span className="plan-node__badge">{str(t.brief['effort'])}</span>}
                    {st && <span className={`plan-node__status plan-node__status--${st}`}>{st}</span>}
                    {onRemove && (
                      <IconTooltip label={`Remove task ${key}`}>
                      <ToolbarButton className="plan-node__remove" label={`Remove task ${key}`} onClick={() => onRemove(key)}>
                        <span className="codicon codicon-close" aria-hidden="true" />
                      </ToolbarButton></IconTooltip>
                    )}
                  </div>
                  <div className="plan-node__objective">{str(t.brief['objective'])}</div>
                  {t.deps.length > 0 && <div className="plan-node__meta">After: {t.deps.join(', ')}</div>}
                  {lease.length > 0 && <div className="plan-node__meta">Files: {lease.join(', ')}</div>}
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ol>
  )
}
