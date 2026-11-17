// Web-read path of a mode-locked Central chat (skill author): `browser_read` is project-scoped, but the author has no
// project tools, so the SERVER picks the board the read runs on. Only `url` and `question` come from the model; the URL
// must be a public http(s) page (same guard as the chat author's browser lock).
import type { Database } from 'bun:sqlite'
import { isPublicWebUrl } from '../browser/browser.publicUrl'
import { syncWorkspaceProjects } from '../central/workspaceLookup'
import { getRow } from '../ledger/ledgerCore'

export const WEB_READ_TOOL = 'browser_read'
const KEPT = ['url', 'question'] as const

/**
 * The model's args reduced to `url`/`question`, plus the server-chosen project; null only when no board exists.
 * `browser_read` runs on a board's browser node, so a real project is required. Ledger projects are created lazily
 * (portfolio read), so the same idempotent sync the portfolio uses runs here first: a fresh data dir with a board
 * no longer depends on anyone having opened the portfolio. The most recently updated live board wins.
 */
export function authorWebReadArgs(db: Database, raw: Record<string, unknown>): Record<string, unknown> | null {
  const live = syncWorkspaceProjects(db) // null = no workspace store (ledger-only): fall back to the newest ledger project
  const fromBoard = live?.[0] === undefined ? undefined : getRow(db, 'SELECT id FROM project WHERE workspace_id = ?', live[0])?.id
  const id = fromBoard ?? (live === null ? getRow(db, 'SELECT id FROM project ORDER BY (status = \'active\') DESC, updated_at DESC LIMIT 1')?.id : undefined)
  if (typeof id !== 'string') return null
  return { ...Object.fromEntries(KEPT.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])), projectId: id }
}

/** Denial detail when the (already schema-checked) url is not a public web page; null when fine. */
export const authorWebReadViolation = (args: Record<string, unknown>): string | null => (isPublicWebUrl(args.url) ? null : 'url_not_public')
