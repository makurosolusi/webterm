// `/api/browser/<nodeId>/design` routes, tried before `handleBrowserApi` (browser.runtime.ts). Same
// `{status, body}` / `null` contract and the same auth: `/api/browser/*` is UI-only (node tokens
// have no path to it), so an agent can never pick elements or send itself design notes.
//
//   POST /api/browser/<id>/design       {on: boolean}     inject / remove the overlay
//   POST /api/browser/<id>/design/send  {comment?: string} queue the note for the cabled agent(s)
import { isSafeNodeId } from '../../../shared/workspace'
import { fail, readObject, type BrowserApiResult } from '../../browserApi.cookies'
import { createLogger } from '../../logs'
import { DESIGN_COMMENT_MAX } from './design.note'
import { DesignError, type DesignMode } from './design.service'

const log = createLogger('browser.design')
const RE = /^\/api\/browser\/([^/]+)\/design(\/send)?$/

export async function designRoute(method: string, pathname: string, body: () => Promise<string>, design: DesignMode): Promise<BrowserApiResult | null> {
  const hit = RE.exec(pathname)
  if (!hit || method !== 'POST') return null
  const nodeId = decodeURIComponent(hit[1])
  if (!isSafeNodeId(nodeId)) return fail(400, 'bad_request')
  const read = await readObject(body)
  if (!read.ok) return read.result
  const v = read.value
  try {
    if (!hit[2]) {
      if (typeof v.on !== 'boolean') return fail(400, 'bad_request', { message: 'on must be a boolean' })
      await design.set(nodeId, v.on)
      return { status: 200, body: { on: design.isOn(nodeId) } }
    }
    const comment = v.comment ?? ''
    if (typeof comment !== 'string' || comment.length > DESIGN_COMMENT_MAX) return fail(400, 'bad_request', { message: `comment: up to ${DESIGN_COMMENT_MAX} characters` })
    return { status: 202, body: await design.send(nodeId, comment) }
  } catch (e) {
    if (e instanceof DesignError) return fail(e.status, e.code, { message: e.message })
    log.warn('design.route', 'Design Mode request failed', { ids: { nodeId }, error: e instanceof Error ? e.message : String(e) })
    return fail(502, 'design_failed', { message: 'The page did not answer. Reload it and try again.' })
  }
}
