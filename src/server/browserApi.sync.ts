// `/api/browser/:nodeId/sync`: GET = whether sync mode is on, POST {on} = switch it. Same auth as every browser route
// (the `/api/*` gate in index.ts: Origin + root token; node tokens have no path here). State is per session, never saved.
import { isSafeNodeId } from '../shared/workspace'
import { BrowserError } from './browser/browserHost.targets'
import { fail, readObject } from './browserApi.cookies'
import type { BrowserApiResult } from './browserApi.cookies'

export interface SyncApiDeps {
  /** Sync state of a node; null = the host does not know the node (no page opened yet). */
  get(nodeId: string): boolean | null
  /** Switch sync (throws `BrowserError('bad_request')` without a split of 2+ panes). */
  set(nodeId: string, on: boolean): boolean
}

export async function syncRoute(method: string, nodeId: string, body: () => Promise<string>, d: SyncApiDeps): Promise<BrowserApiResult> {
  if (!isSafeNodeId(nodeId)) return fail(400, 'bad_request')
  if (method === 'GET') { const on = d.get(nodeId); return on === null ? fail(404, 'not_found') : { status: 200, body: { on } } }
  if (method !== 'POST') return fail(405, 'method_not_allowed')
  const read = await readObject(body)
  if (!read.ok) return read.result
  if (typeof read.value.on !== 'boolean') return fail(400, 'bad_request', { message: 'on must be true or false' })
  try {
    return { status: 200, body: { on: d.set(nodeId, read.value.on) } }
  } catch (err) {
    if (err instanceof BrowserError) return fail(err.code === 'not_found' ? 404 : 400, err.code, { message: err.message })
    throw err
  }
}
