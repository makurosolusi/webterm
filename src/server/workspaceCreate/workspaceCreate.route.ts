// HTTP binding of workspaceCreate.ts. Every verb makes folders or runs git, so all of it is
// human-UI only (`uiOnlyDenial`, as workspaceWorktree.route.ts): an agent credential gets 403.
//
//   GET  /api/workspace-create/defaults            {parent}  nodeterm cloneDefaultParent
//   POST /api/workspace-create/clone   {url, parent, name?}   NDJSON stream: {type:'progress',phase,percent}*
//                                                             then {type:'done',path} | {type:'error',error,message}
//   POST /api/workspace-create/clone/cancel                   abort the in-flight clone (nodeterm cloneAbort)
//   POST /api/workspace-create/project {parent, name, gitInit?}  201 {path}
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { json } from '../routes/route.core'
import { CreateError, abortClone, cloneRepo, createProject, defaultParent, type CreateDeps } from './workspaceCreate'

export const WORKSPACE_CREATE_PREFIX = '/api/workspace-create'
export const WORKSPACE_CREATE_BODY_MAX_BYTES = 16 * 1024

const STATUS: Record<CreateError['code'], number> = { bad_request: 400, exists: 409, busy: 409, git_failed: 422, aborted: 499 }

export interface WorkspaceCreateRouteDeps extends CreateDeps { isNodeToken?: (token: string) => boolean }

/** true once it answered (or started streaming); false = not this family. */
export async function workspaceCreateRoute(
  req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<string>, deps: WorkspaceCreateRouteDeps = {},
): Promise<boolean> {
  const path = url.pathname
  if (path !== WORKSPACE_CREATE_PREFIX && !path.startsWith(`${WORKSPACE_CREATE_PREFIX}/`)) return false
  // Lazy: hooksTokens pulls in the session layer (PTY supervisor adoption); tests inject isNodeToken.
  const isNodeToken = deps.isNodeToken ?? (await import('../hooksTokens')).isValidNodeToken
  const denial = uiOnlyDenial(req, url, isNodeToken)
  if (denial) {
    json(res, 403, { error: denial === AGENT_CANNOT_APPROVE ? 'agent_cannot_create_workspaces' : denial, message: 'Projects are cloned and created by the human at the webterm UI only.' })
    return true
  }
  const method = req.method ?? 'GET'
  const sub = path.slice(WORKSPACE_CREATE_PREFIX.length)
  if (method === 'GET' && sub === '/defaults') { json(res, 200, { parent: await defaultParent() }); return true }
  if (method !== 'POST') return false
  if (sub === '/clone/cancel') { json(res, 200, { aborted: abortClone() }); return true }
  if (sub !== '/clone' && sub !== '/project') return false

  let b: Record<string, unknown>
  try { b = JSON.parse(await body()) } catch { json(res, 400, { error: 'bad_request', message: 'bad json' }); return true }
  const str = (k: string): string => (b && typeof b[k] === 'string' ? (b[k] as string) : '')
  const fail = (e: unknown): void => {
    if (!(e instanceof CreateError)) throw e // unexpected: api.ts logs it and answers 500
    json(res, STATUS[e.code], { error: e.code, message: e.message })
  }

  if (sub === '/project') {
    try { json(res, 201, { path: await createProject({ parent: str('parent'), name: str('name'), gitInit: b.gitInit !== false }, deps) }) } catch (e) { fail(e) }
    return true
  }

  // Clone: the stream starts at the first progress line; failures before that answer a plain status.
  let streaming = false
  const line = (o: unknown): void => {
    if (!streaming) {
      streaming = true
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/x-ndjson')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('X-Accel-Buffering', 'no')
    }
    if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`)
  }
  // The dialog closing mid-clone drops the request: treat it as Cancel so the partial folder goes.
  let finished = false
  res.on('close', () => { if (!finished) abortClone() })
  try {
    const cloned = await cloneRepo({ url: str('url'), parent: str('parent'), name: str('name') || undefined }, (p) => line({ type: 'progress', ...p }), deps)
    finished = true
    line({ type: 'done', path: cloned })
    res.end()
  } catch (e) {
    finished = true
    if (!streaming) { fail(e); return true }
    const ce = e instanceof CreateError ? e : new CreateError('git_failed', 'Clone failed.')
    line({ type: 'error', error: ce.code, message: ce.message })
    res.end()
  }
  return true
}
