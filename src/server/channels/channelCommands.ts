// Bound-chat slash commands (/status, /inbox, /approve, /reject, ...) -> reply text. Only reached
// after channelDispatch.ts has authorized the command; approval checks stay in the ledger. Telegram
// is a door into the Central conversation, so the replies speak as Central: `/inbox` is the same
// "Needs you" list the Central strip shows (inbox/needsYou.ts), not a per-project approval list.
import type { ChannelBinding, ChannelCommand } from './identity'
import { handleApprove, handleReject, type ApprovalDeps } from './channelApprovals'
import type { NormalizedMessage } from './telegram'
import { renderWorldLine, type WorldCountsPort } from './channelWorld'
import type { NeedsYouGroup } from '../inbox/needsYou'
import { createLogger } from '../logs'

const log = createLogger('channels')
/** Items listed per group; the count line still covers them all. */
const TOP_ITEMS = 3

export type NeedsYouPort = () => NeedsYouGroup[] | null

export interface CommandDeps extends ApprovalDeps {
  /** World-view counts for `/status`; omitted or null = the line is left out. */
  world?: WorldCountsPort
  /** The Central "Needs you" read; omitted = the process ledger. */
  needsYou?: NeedsYouPort
}

/**
 * Production port: the live ledger DB. Required lazily, like the world view: it opens SQLite through
 * bun:sqlite, which node-env vitest (the dispatcher's tests) cannot load.
 */
export const defaultNeedsYou: NeedsYouPort = () => {
  try {
    const { activeLedgerRuntime } = require('../ledger/ledgerRuntimeState') as typeof import('../ledger/ledgerRuntimeState')
    const db = activeLedgerRuntime()?.db
    if (!db) return null
    return (require('../inbox/needsYou') as typeof import('../inbox/needsYou')).readNeedsYou(db)
  } catch (err) {
    log.warn('channels.needs_you_failed', 'needs-you list unavailable for a bot reply', { error: err instanceof Error ? err.message : typeof err })
    return null
  }
}

const UNAVAILABLE = 'Needs you: unavailable right now (the ledger runtime is off). Nothing changed.'

/** `/inbox`: count per group plus its oldest items, in the strip's order. */
export function renderNeedsYou(groups: NeedsYouGroup[]): string {
  const total = groups.reduce((sum, g) => sum + g.count, 0)
  if (total === 0) return 'Needs you: nothing right now.'
  const lines = [`Needs you: ${total} item${total === 1 ? '' : 's'}.`]
  for (const group of groups) {
    if (group.count === 0) continue
    lines.push('', `${group.name} (${group.count})`)
    for (const item of group.items.slice(0, TOP_ITEMS)) lines.push(`- ${item.title}`)
    if (group.count > TOP_ITEMS) lines.push(`- and ${group.count - TOP_ITEMS} more`)
  }
  return lines.join('\n')
}

/** `/status`: one line of the same counts. */
function needsYouLine(groups: NeedsYouGroup[]): string {
  return `Needs you: ${groups.map((g) => `${g.count} ${g.name.toLowerCase()}`).join(', ')}.`
}

/** Runs an authorized command and returns the text to send back. */
export async function runCommand(
  deps: CommandDeps,
  message: NormalizedMessage,
  binding: ChannelBinding,
  command: ChannelCommand
): Promise<string> {
  const needsYou = (): NeedsYouGroup[] | null => (deps.needsYou ?? defaultNeedsYou)()
  switch (command.kind) {
    case 'status': {
      const counts = deps.world?.() ?? null
      const groups = needsYou()
      return [counts ? renderWorldLine(counts) : null, groups ? needsYouLine(groups) : UNAVAILABLE]
        .filter((line): line is string => line !== null).join('\n')
    }
    case 'inbox': {
      const groups = needsYou()
      return groups ? renderNeedsYou(groups) : UNAVAILABLE
    }
    case 'approve':
      return handleApprove(deps, message, binding, command)
    case 'reject':
      return handleReject(deps, message, binding, command)
    case 'pause':
    case 'resume':
      return "Central's work is stopped and resumed from the Central panel in webterm (/halt there asks first). This chat does not change it."
    case 'task':
      return `Ask me in plain words, for example: "Show the status of task ${command.taskId}."`
  }
}
