import { Button } from '@/components/ui/button'
import type { BoardColumn } from '../../../shared/centralWork'
import { TaskCard, type TaskCardProps } from './TaskCard'
import { TL } from './taskBoardLabels'
import type { ColumnState } from './taskBoardModel'

export interface TaskColumnProps {
  column: BoardColumn
  state: ColumnState
  collapsed: boolean
  /** Present only on a column that can fold. */
  onToggle?: () => void
  loadingMore: boolean
  onLoadMore: (column: BoardColumn) => void
  busy: ReadonlySet<string>
  refused: Readonly<Record<string, string>>
  selectedId: string | null
  onAct: TaskCardProps['onAct']
  onOpen: TaskCardProps['onOpen']
  linkDown?: boolean
}

/** One board column with its count, its cards and its own Load more. */
export function TaskColumn(p: TaskColumnProps): React.JSX.Element {
  const name = TL.columns[p.column]
  const count = `${p.state.items.length}${p.state.hasMore ? '+' : ''}`
  return (
    <section className="task-column" data-column={p.column} data-collapsed={p.collapsed ? 'true' : undefined} aria-label={name}>
      <header className="task-column__head">
        {p.onToggle
          ? <Button type="button" size="xs" variant="ghost" aria-expanded={!p.collapsed} aria-label={p.collapsed ? TL.expandColumn(name) : TL.collapseColumn(name)} onClick={p.onToggle}>
              <span className={`codicon codicon-chevron-${p.collapsed ? 'right' : 'down'}`} aria-hidden="true" />{name}
            </Button>
          : <h3>{name}</h3>}
        <span className="task-column__count" aria-label={TL.columnCount(count, name)}>{count}</span>
      </header>
      {!p.collapsed && (
        <div className="task-column__body">
          {p.state.items.map((card) => (
            <TaskCard key={card.id} card={card} busy={p.busy.has(card.id)} refused={p.refused[card.id]} selected={p.selectedId === card.id} onAct={p.onAct} onOpen={p.onOpen} linkDown={p.linkDown} />
          ))}
          {p.state.hasMore && (
            <Button type="button" size="xs" variant="secondary" disabled={p.loadingMore} aria-label={`${TL.loadMore}: ${name}`} onClick={() => p.onLoadMore(p.column)}>
              {p.loadingMore ? TL.loadingMore : TL.loadMore}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
