import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { isAbortError } from '../../inboxApi'
import { CapabilityOffer } from '../../CapabilityOffer'
import { centralErrorMessage, useLoad } from '../centralLoad'
import { TaskColumn } from './TaskColumn'
import { TaskDetail } from './TaskDetail'
import { taskBoardApi, type TaskBoardClient } from './taskBoardApi'
import { TL } from './taskBoardLabels'
import { COLUMN_ORDER } from './taskBoardModel'
import { useTaskActions, useTaskBoard } from './useTaskBoard'
import './taskBoard.css'

export interface TaskBoardProps {
  client?: TaskBoardClient
  /** False while the tab sits mounted behind another view. */
  visible?: boolean
}

/** localStorage key of the remembered project filter. */
export const TASK_BOARD_PROJECT_KEY = 'webterm.taskBoardProject'
/** Select value for "no project filter" (Radix Select has no empty value). */
const ALL_PROJECTS = 'all'

function readRememberedProject(): string {
  try {
    return localStorage.getItem(TASK_BOARD_PROJECT_KEY) ?? ALL_PROJECTS
  } catch (err) {
    console.warn('task board: reading the remembered project failed', err)
    return ALL_PROJECTS
  }
}

function rememberProject(id: string): void {
  try {
    localStorage.setItem(TASK_BOARD_PROJECT_KEY, id)
  } catch (err) {
    console.warn('task board: remembering the project failed', err)
  }
}

function AutoDoneSwitch({ client, projectId }: { client: TaskBoardClient; projectId: string }): React.JSX.Element {
  const [value, setValue] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    client.getAutoDone(projectId, ac.signal).then(
      (on) => { if (!ac.signal.aborted) { setValue(on); setReady(true) } },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) setError(centralErrorMessage(err, TL.autoDoneLoadFailed)) },
    )
    return () => ac.abort()
  }, [client, projectId])
  const change = async (next: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await client.setAutoDone(projectId, next)
      setValue(next)
    } catch (err) {
      setError(centralErrorMessage(err, TL.autoDoneFailed))
    } finally {
      setSaving(false)
    }
  }
  return (
    <label className="task-board__switch">
      <Switch aria-label={TL.autoDone} checked={value} disabled={!ready || saving} onCheckedChange={(on) => void change(on)} />
      {TL.autoDone}
      {error && <span role="alert" className="task-board__error">{error}</span>}
    </label>
  )
}

/** The Central task board: four columns of tasks with a side detail for the selected one. */
export default function TaskBoard({ client = taskBoardApi, visible = true }: TaskBoardProps): React.JSX.Element {
  const [project, setProject] = useState(readRememberedProject)
  const [doneOpen, setDoneOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const projects = useLoad((signal) => client.listProjects(signal))
  // A remembered project that no longer exists falls back to all, without forgetting it on a failed read.
  const known = projects.data?.some((p) => p.id === project) ?? false
  const value = project === ALL_PROJECTS || (!projects.loading && !known) ? ALL_PROJECTS : project
  const projectId = value === ALL_PROJECTS ? undefined : value
  const board = useTaskBoard(client, projectId, visible)
  const { busy, refused, act } = useTaskActions(client, board.refresh)

  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) projects.reload()
    wasVisible.current = visible
  }, [visible])

  const restoreFocus = useRef<HTMLElement | null>(null)
  const open = useCallback((id: string) => {
    if (document.activeElement instanceof HTMLElement) restoreFocus.current = document.activeElement
    setSelected(id)
  }, [])
  const close = (): void => { setSelected(null); restoreFocus.current?.focus() }
  const select = (id: string): void => { setProject(id); rememberProject(id); setSelected(null) }

  const empty = board.columns !== null && COLUMN_ORDER.every((c) => board.columns![c].items.length === 0)

  return (
    <div className="task-board" aria-label={TL.board}>
      <div className="task-board__toolbar">
        <Select value={value} onValueChange={select}>
          <SelectTrigger aria-label={TL.projectFilter}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>{TL.allProjects}</SelectItem>
            {projects.data?.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {projectId && <AutoDoneSwitch key={projectId} client={client} projectId={projectId} />}
      </div>
      {board.off && <div className="task-board__state" data-central-off="tasks"><p>{TL.off}</p><CapabilityOffer id="central" onDone={board.retry} /></div>}
      {board.loading && <p role="status" className="task-board__state">{TL.loading}</p>}
      {board.error && (
        <div role="alert" className="task-board__state task-board__error">
          {board.error} <Button type="button" size="xs" variant="secondary" onClick={board.retry}>{TL.retry}</Button>
        </div>
      )}
      {empty && !board.error && <p className="task-board__state">{TL.empty}</p>}
      {board.columns && !empty && (
        <div className="task-board__main">
          <div className="task-board__columns">
            {COLUMN_ORDER.map((column) => (
              <TaskColumn
                key={column} column={column} state={board.columns![column]}
                collapsed={column === 'done' && !doneOpen}
                onToggle={column === 'done' ? () => setDoneOpen((o) => !o) : undefined}
                loadingMore={board.loadingMore.has(column)} onLoadMore={board.loadMore}
                busy={busy} refused={refused} selectedId={selected} onAct={act} onOpen={open}
              />
            ))}
          </div>
          {selected && <TaskDetail key={selected} client={client} taskId={selected} refreshTick={board.refreshTick} onClose={close} />}
        </div>
      )}
    </div>
  )
}
