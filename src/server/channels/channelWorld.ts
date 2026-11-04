// Counts in bot replies come from the world view (PLAN 01 K5) so Telegram shows the same numbers
// as the canvas and the Central portfolio (exit criterion A4). The module is required lazily: it
// opens SQLite through bun:sqlite, which node-env vitest cannot load.
import type { WorldCounts } from '../worldView'
import { createLogger } from '../logs'

const log = createLogger('channels')

export type WorldCountsPort = () => WorldCounts | null

/** Production port: the shared read-only world view, or null when it cannot be read. */
export const defaultWorldCounts: WorldCountsPort = () => {
  try {
    return (require('../worldView') as { worldCounts(): WorldCounts }).worldCounts()
  } catch (err) {
    // The reply is still useful without the counts; say why they are missing in the log.
    log.warn('channels.world_counts_failed', 'world-view counts unavailable for a bot reply', {
      error: err instanceof Error ? err.name : typeof err,
    })
    return null
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * One line, canvas vocabulary: workspaces are the canvas projects, agent nodes are its agents, and
 * tasks are ledger tasks of projects whose workspace still exists.
 */
export function renderWorldLine(c: WorldCounts): string {
  const parts = [plural(c.workspaces, 'project'), plural(c.agentNodes, 'agent')]
  if (c.ledger) parts.push(`${c.ledger.tasks.open} open of ${plural(c.ledger.tasks.total, 'task')}`)
  return `Canvas: ${parts.join(', ')}.`
}
