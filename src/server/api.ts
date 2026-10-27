import type { IncomingMessage, ServerResponse } from 'node:http'
import { db } from './db'

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
      let body: { name: string; cwd?: string; color?: string; viewport: unknown; nodes: unknown }
      try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'bad json' }) }
      const ws = { id, name: body.name, cwd: body.cwd, color: body.color, viewport: body.viewport, nodes: body.nodes, updatedAt: Date.now() } as Parameters<typeof db.save>[0]
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

  json(res, 404, { error: 'unknown route' })
}

// Returns true when it has taken over the response; false lets the caller fall
// through to Vite/static. The response is finished asynchronously.
export function handleApi(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url || !req.url.startsWith('/api/')) return false
  void route(req, res)
  return true
}
