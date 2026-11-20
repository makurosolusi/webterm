// HTTP binding of workspaceCreate.ts. Every verb makes folders, runs git or reads the disk, so all
// of it is human-UI only (`uiOnlyDenial`, as workspaceWorktree.route.ts): an agent credential gets 403.
//
//   GET  /api/workspace-create/defaults?remembered=  {parent, projectsFolder, builtin}: the remembered
//                                                    parent while it is a folder, else the projects folder
//   POST /api/workspace-create/projects-folder/check {path}  200 {path} | 400 why it cannot be the default
//   POST /api/workspace-create/check   {parent, name?, url?}  preflight: target, taken + next free name,
//                                                             wrong-place warnings, already cloned
//   POST /api/workspace-create/clone   {url, parent, name?}   NDJSON stream: {type:'progress',phase,percent}*
//                                                             then {type:'done',path} | {type:'error',error,message}
//   POST /api/workspace-create/clone/cancel                   abort the in-flight clone
//   POST /api/workspace-create/project {parent, name, gitInit?}  201 {path, bootstrapIdentity}
//   POST /api/workspace-create/reveal  {path}                 show it in Finder / the file manager
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import { AGENT_CANNOT_APPROVE, uiOnlyDenial } from '../approvalAuth'
import { json } from '../routes/route.core'
import type { Candidate, FindDeps } from './alreadyCloned'
import { preflight } from './preflight'
import { builtinProjectsFolder, folderEnv, projectsFolder, projectsFolderError, revealPath, suggestedParent, type FolderEnv, type RevealDeps } from './projectsFolder'
import { CreateError, abortClone, cloneRepo, createProject, type CreateDeps } from './workspaceCreate'

export const WORKSPACE_CREATE_PREFIX = '/api/workspace-create'
export const WORKSPACE_CREATE_BODY_MAX_BYTES = 16 * 1024

const STATUS: Record<CreateError['code'], number> = { bad_request: 400, exists: 409, busy: 409, git_failed: 422, aborted: 499 }
const POSTS = ['/clone', '/project', '/check', '/reveal', '/projects-folder/check']

export interface WorkspaceCreateRouteDeps extends CreateDeps {
  isNodeToken?: (token: string) => boolean
  /** HOME, data dir and the stored setting; tests inject temp dirs so nothing real is read. */
  env?: () => Promise<FolderEnv>
  /** Existing workspaces with a folder, for "already cloned". */
  workspaces?: () => Promise<Candidate[]>
  find?: FindDeps
  reveal?: RevealDeps
}

async function dbWorkspaces(): Promise<Candidate[]> {
  const { db } = await import('../db')
  return db.list().flatMap((w) => (w.cwd ? [{ path: w.cwd, workspaceId: w.id }] : []))
}

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
  const env = (): Promise<FolderEnv> => (deps.env ?? folderEnv)()
  if (method === 'GET' && sub === '/defaults') {
    const e = await env()
    json(res, 200, {
      parent: await suggestedParent(url.searchParams.get('remembered') ?? '', e),
      projectsFolder: await projectsFolder(e),
      builtin: builtinProjectsFolder(e.home, e.dataDir),
    })
    return true
  }
  if (method !== 'POST') return false
  if (sub === '/clone/cancel') { json(res, 200, { aborted: abortClone() }); return true }
  if (!POSTS.includes(sub)) return false

  let b: Record<string, unknown>
  try { b = JSON.parse(await body()) } catch { json(res, 400, { error: 'bad_request', message: 'bad json' }); return true }
  const str = (k: string): string => (b && typeof b[k] === 'string' ? (b[k] as string) : '')
  const fail = (e: unknown): void => {
    if (!(e instanceof CreateError)) throw e // unexpected: api.ts logs it and answers 500
    json(res, STATUS[e.code], { error: e.code, message: e.message })
  }
  // The create calls refuse the data dir; hand them the injected one so tests never touch the real one.
  const createDeps = async (): Promise<CreateDeps> => (deps.dataDir || !deps.env ? deps : { ...deps, dataDir: (await env()).dataDir })

  if (sub === '/projects-folder/check') {
    const why = await projectsFolderError(str('path'), await env())
    json(res, why ? 400 : 200, why ? { error: 'bad_request', message: why } : { path: str('path').trim() })
    return true
  }
  if (sub === '/check') {
    try {
      json(res, 200, await preflight({ parent: str('parent'), name: str('name'), url: str('url') }, { env: await env(), workspaces: deps.workspaces ?? dbWorkspaces, find: deps.find }))
    } catch (e) { fail(e) }
    return true
  }
  if (sub === '/reveal') {
    const p = str('path')
    if (!isAbsolute(p) || !(await stat(p).then(() => true, () => false))) {
      json(res, 400, { error: 'bad_request', message: 'Nothing to reveal at that path.' })
      return true
    }
    try {
      await revealPath(p, deps.reveal)
      json(res, 200, { ok: true })
    } catch (e) {
      json(res, 422, { error: 'reveal_failed', message: (e as Error).message })
    }
    return true
  }
  if (sub === '/project') {
    try { json(res, 201, await createProject({ parent: str('parent'), name: str('name'), gitInit: b.gitInit !== false }, await createDeps())) } catch (e) { fail(e) }
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
    const cloned = await cloneRepo({ url: str('url'), parent: str('parent'), name: str('name') || undefined }, (p) => line({ type: 'progress', ...p }), await createDeps())
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
