import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import npath from 'node:path'
import { db } from './db'
import { sessions } from './sessions'
import { settingsRoute } from './settingsApi'
import { fsApiRoute } from './fsApi'
import { readErrorResult } from './fsOps'
import { hookStatus } from './hooks'
import { renderForRequester, CONTEXT_LINK_VERBS, type ContextLinkVerb } from './contextLink'
import type { BridgeLink } from '../shared/workspace'

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Push the stored shell/scrollback/agent settings into the live PTY factory. Boot + every PUT. */
export function applyPtyOptions(): void {
  const s = db.getSettings()
  sessions.options = {
    shell: s.defaultShell,
    scrollbackBytes: s.scrollbackBytes,
    // `--permission-mode auto` baru ada di Claude Code >= 2.1.71 dan webterm belum punya probe
    // versi CLI, jadi mode default 'auto' diteruskan sebagai ABSEN: peluncuran claude tetap polos
    // persis seperti sebelum setting ini ada. Mode pilihan user eksplisit tetap diteruskan.
    claudePermissionMode: s.claudePermissionMode === 'auto' ? undefined : s.claudePermissionMode,
    hookReplyApprovals: s.hookReplyApprovals,
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://x')
  const path = url.pathname
  const method = req.method || 'GET'

  // /api/workspaces[/:id]
  if (path === '/api/workspaces') {
    if (method === 'GET') return json(res, 200, db.list())
    if (method === 'POST') {
      let body: { name: string; cwd?: string; color?: string }
      try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'bad json' }) }
      return json(res, 201, db.create(body.name, body.cwd, body.color))
    }
  }

  const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/)
  if (wsMatch) {
    const id = decodeURIComponent(wsMatch[1])
    if (method === 'GET') {
      const ws = db.get(id)
      return ws ? json(res, 200, ws) : json(res, 404, { error: 'not found' })
    }
    if (method === 'PUT') {
      let body: { name: string; cwd?: string; color?: string; viewport: unknown; nodes: unknown; bridges?: BridgeLink[] }
      try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'bad json' }) }
      const ws = { id, name: body.name, cwd: body.cwd, color: body.color, viewport: body.viewport, nodes: body.nodes, bridges: body.bridges ?? [], updatedAt: Date.now() } as Parameters<typeof db.save>[0]
      db.save(ws)
      const saved = db.get(id)
      return saved ? json(res, 200, saved) : json(res, 404, { error: 'not found' })
    }
    if (method === 'DELETE') {
      db.delete(id)
      res.statusCode = 204
      res.end()
      return
    }
  }

  // /api/active
  if (path === '/api/active') {
    if (method === 'GET') return json(res, 200, { id: db.getActive() })
    if (method === 'PUT') {
      let body: { id: string }
      try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'bad json' }) }
      db.setActive(body.id)
      res.statusCode = 204
      res.end()
      return
    }
  }

  if (path === '/api/settings') {
    await settingsRoute(req, res, method)
    // A saved defaultShell/scrollbackBytes must reach the NEXT spawned PTY without a restart.
    if (method === 'PUT') applyPtyOptions()
    return
  }

  // Six filesystem verbs under /api/fs/<verb>; returns null for anything else, including the
  // exact /api/fs folder picker below, whose response shape is different.
  // `read`/`read-binary` throw on an unreadable file (see the fsOps header): 200 with an empty
  // body looks like a readable EMPTY file, and the editor then truncates it on the next save.
  const fsRes = await fsApiRoute(path, method, url.searchParams, () => readBody(req))
    .catch(readErrorResult)
  if (fsRes) return json(res, fsRes.status, fsRes.body)

  // Hook callback from a claude session (body is the hook stdin JSON).
  if (path === '/api/agent-status' && method === 'POST') {
    const node = url.searchParams.get('node')
    let body: { hook_event_name?: string; message?: string; transcript_path?: string }
    try { body = JSON.parse(await readBody(req)) } catch { body = {} }
    const status = node ? hookStatus(body) : null
    if (node && status) sessions.setStatus(node, status)
    if (node && typeof body.transcript_path === 'string') sessions.setTranscript(node, body.transcript_path)
    res.statusCode = 204; res.end(); return
  }

  // Read-only context-link: a linked node reads a bridged peer's transcript/terminal.
  if (path === '/api/context-link' && method === 'GET') {
    const requester = url.searchParams.get('node') || ''
    const raw = url.searchParams.get('verb') || 'list'
    const verb = (CONTEXT_LINK_VERBS as string[]).includes(raw) ? (raw as ContextLinkVerb) : 'list'
    const want = url.searchParams.get('want') || undefined
    const n = url.searchParams.get('n') || undefined
    const text = await renderForRequester(requester, verb, { node: want, n })
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(text)
    return
  }

  // AI name-gen: spawn claude -p on a node's terminal buffer, return a suggested title.
  if (path === '/api/generate-name' && method === 'GET') {
    const node = url.searchParams.get('node') || ''
    const { generateName } = await import('./nameGen')
    return json(res, 200, await generateName(node))
  }

  // Server-side folder picker: list subdirectories of a dir (dotfiles hidden).
  if (path === '/api/fs' && method === 'GET') {
    const dir = url.searchParams.get('path') || homedir()
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
      const parent = npath.dirname(dir)
      return json(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs })
    } catch {
      return json(res, 404, { error: 'cannot read dir' })
    }
  }

  json(res, 404, { error: 'unknown route' })
}

// Returns true when it has taken over the response; false lets the caller fall
// through to Vite/static. The response is finished asynchronously.
export function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url || !req.url.startsWith('/api/')) return false
  void route(req, res)
  return true
}
