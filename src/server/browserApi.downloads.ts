// Download routes of a browser node: `/api/browser/:nodeId/downloads[/...]`. Same gate as every other `/api/browser/*` route
// (Origin + root token; a node token has no path to this prefix). The server never opens a file manager and never writes
// outside its data dir: `file` hands the bytes to the caller's browser as an attachment, so the PERSON picks where a copy goes.
import { isSafeNodeId } from '../shared/workspace'
import type { HostDownloads } from './browser/browserHost.downloads'
import { fail } from './browserApi.cookies'
import type { BrowserApiResult } from './browserApi.cookies'

export type DownloadsApiDeps = Pick<HostDownloads, 'list' | 'cancel' | 'remove' | 'keep' | 'file'>

/** A browser-issued download guid; anything else never reaches the file system. */
const DOWNLOAD_ID = /^[A-Za-z0-9-]{1,64}$/

const done = (ok: boolean): BrowserApiResult => (ok ? { status: 204 } : fail(404, 'not_found'))

/** One download request; `rest` = segments after `downloads`. null = not a download route. */
export function downloadsRoute(method: string, nodeId: string, rest: string[], d: DownloadsApiDeps): BrowserApiResult | null {
  if (!isSafeNodeId(nodeId)) return fail(400, 'bad_request')
  const [id, action, ...more] = rest
  if (more.length) return null
  if (id === undefined) return method === 'GET' ? { status: 200, body: { items: d.list(nodeId) } } : fail(405, 'method_not_allowed')
  if (!DOWNLOAD_ID.test(id)) return fail(400, 'bad_request')
  if (action === undefined) return method === 'DELETE' ? done(d.remove(nodeId, id)) : fail(405, 'method_not_allowed')
  if (action === 'cancel' || action === 'keep') return method === 'POST' ? done(action === 'cancel' ? d.cancel(nodeId, id) : d.keep(nodeId, id)) : fail(405, 'method_not_allowed')
  if (action !== 'path' && action !== 'file') return null
  if (method !== 'GET') return fail(405, 'method_not_allowed')
  const f = d.file(nodeId, id)
  if (!f) return fail(404, 'not_found')
  // `path` answers with the location only (the client copies it); nothing is opened on this machine.
  return action === 'path' ? { status: 200, body: { path: f.path } } : { status: 200, file: f }
}
