// What one Sessions side bar row and group header SAY (description, time, tooltip, accessible
// names) and the Recently closed filter. Pure and DOM-free like `./sessionList`, so vitest pins it.
import { BUCKET_LABEL, type StatusBucket } from './sessionStatus.model'
import { formatAge } from './nodeStatusBar.rules'
import { dirName, sessionLabel, type SessionRowVM } from './sessionList'
import type { ClosedEntry } from './closedHistory'

/** Codicon of each Status-tab bucket header: the status icon is shown ONCE, on the header. */
export const BUCKET_ICON: Record<StatusBucket, string> = {
  'needs-input': 'bell',
  working: 'loading',
  idle: 'circle-outline',
  error: 'error',
  exited: 'circle-slash',
}

/** Compact last-activity time for the row's right edge: "now", "5m", "2h", "3d"; '' when unknown. */
export function rowAge(since: number | undefined, now: number): string {
  if (since === undefined) return ''
  const ms = now - since
  if (ms < 60_000) return 'now'
  return formatAge(ms).split(' ')[0]
}

/**
 * The row's description (grey text after the name). Project tab: the folder only when it differs
 * from the group's own (the header already names it), and the reason when the row needs you or
 * failed. Status tab: the status detail ("Turn ended", "Waiting for approval: Bash") unless the
 * bucket header already says it, then the workspace, since that tab mixes every board.
 */
export function rowDescription(row: SessionRowVM, mode: 'project' | 'status', groupCwd?: string): string {
  const v = row.view
  if (mode === 'status') {
    const detail = v.label === BUCKET_LABEL[v.bucket] ? '' : v.label
    return [detail, row.projectName].filter(Boolean).join(' · ')
  }
  const reason = v.bucket === 'needs-input' || v.bucket === 'error' ? v.label : ''
  const folder = dirName(row.cwd)
  return [reason, folder && folder !== dirName(groupCwd) ? folder : ''].filter(Boolean).join(' · ')
}

/** Hover text of a row: full name, folder, status and how long ago it began. */
export function rowTooltip(row: SessionRowVM, now: number): string {
  const age = rowAge(row.view.since, now)
  const when = age === '' ? '' : age === 'now' ? ' · just now' : ` · ${age} ago`
  return [row.label, dirName(row.cwd), `${row.view.label}${when}`].filter(Boolean).join(' — ')
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Tooltip / label of the header count. */
export const sessionsCountLabel = (n: number): string => plural(n, 'session', 'sessions')
/** Tooltip / label of the header's attention badge. */
export const needsYouLabel = (n: number): string => `${n} need${n === 1 ? 's' : ''} you`

/** Accessible name of a group header: "laya-api, current workspace, 3 sessions, 1 needs you". */
export function groupAriaLabel(label: string, count: number, attention: number, isActive: boolean): string {
  return [label, isActive ? 'current workspace' : '', sessionsCountLabel(count), attention > 0 ? needsYouLabel(attention) : '']
    .filter(Boolean)
    .join(', ')
}

/** Recently closed entries matching the side bar filter (name, workspace, folder). */
export function filterClosed(entries: ClosedEntry[], filter: string): ClosedEntry[] {
  const needle = filter.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter((e) => `${sessionLabel(e.node)} ${e.workspaceName} ${e.node.cwd ?? ''}`.toLowerCase().includes(needle))
}
