// Web-read path of a mode-locked Central chat (skill author): `browser_read` is project-scoped, but the author has no
// project tools, so the SERVER picks the board the read runs on. Only `url` and `question` come from the model; the URL
// must be a public http(s) page (same guard as the chat author's browser lock).
import type { Database } from 'bun:sqlite'
import { isPublicWebUrl } from '../browser/browser.publicUrl'
import { getRow } from '../ledger/ledgerCore'

export const WEB_READ_TOOL = 'browser_read'
const KEPT = ['url', 'question'] as const

/** The model's args reduced to `url`/`question`, plus the server-chosen project (most recently updated); null when no project exists. */
export function authorWebReadArgs(db: Database, raw: Record<string, unknown>): Record<string, unknown> | null {
  const id = getRow(db, 'SELECT id FROM project ORDER BY (status = \'active\') DESC, updated_at DESC LIMIT 1')?.id
  if (typeof id !== 'string') return null
  return { ...Object.fromEntries(KEPT.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])), projectId: id }
}

/** Denial detail when the (already schema-checked) url is not a public web page; null when fine. */
export const authorWebReadViolation = (args: Record<string, unknown>): string | null => (isPublicWebUrl(args.url) ? null : 'url_not_public')
