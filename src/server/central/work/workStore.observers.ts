// Observers of committed task moves, keyed by database.
import type { Database } from 'bun:sqlite'
import { createLogger } from '../../logs'
import type { WorkMove } from './workModel'

const log = createLogger('central.work')

// Keyed by database, not by store: tools build a store per call, and each of them must be observed.
const moveObservers = new WeakMap<Database, Set<(move: WorkMove) => void>>()

/** Calls `fn` after the commit of every task move on `db`, whichever store made it; a throw is logged and never reaches the mover. */
export function onWorkMove(db: Database, fn: (move: WorkMove) => void): void {
  const observers = moveObservers.get(db) ?? new Set()
  moveObservers.set(db, observers.add(fn))
}

/** Hands every move to each observer of `db`; an observer's throw is logged and swallowed. */
export function publishMoves(db: Database, moves: readonly WorkMove[]): void {
  for (const fn of moveObservers.get(db) ?? []) {
    for (const move of moves) {
      try {
        fn(move)
      } catch (err) {
        log.error('work.move_observer_failed', `observer of task ${move.task.id} moving to ${move.to} failed`, { taskId: move.task.id, seq: move.seq, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}
