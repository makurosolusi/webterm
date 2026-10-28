import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { WS_PATH, type ClientMsg, type ServerMsg } from '../shared/protocol'
import { sessions } from './sessions'
import { handleApi } from './api'
import { installContextLinkShim } from './contextLink'
import { DEFAULT_HOST, TOKEN_PARAM, authorize, resolveToken } from './auth'

const PORT = Number(process.env.PORT) || 8700
const HOST = process.env.WEBTERM_HOST || DEFAULT_HOST
// Throws (and so refuses to start) when HOST is reachable off-machine without a token.
const TOKEN = resolveToken(HOST, process.env.WEBTERM_TOKEN)
const dev = process.env.NODE_ENV !== 'production'

const API_PREFIX = '/api/'

function reqUrl(req: http.IncomingMessage): URL {
  return new URL(req.url || '/', 'http://x')
}

/**
 * Gate for the two surfaces that act on the machine: /api (filesystem, workspaces) and the
 * /ws upgrade (PTYs). Static assets are deliberately NOT gated — the app bundle is not a
 * privilege, and gating it would break every sub-resource request, which carries no token.
 */
function allowed(req: http.IncomingMessage, url: URL): boolean {
  return authorize({ headers: req.headers, expectedToken: TOKEN, queryToken: url.searchParams.get(TOKEN_PARAM) })
}

function refuse(res: http.ServerResponse): void {
  res.statusCode = 403
  res.end('forbidden')
}

// Write the context-link sh shim the installed get-linked-context skill invokes.
installContextLinkShim()

const server = http.createServer()

if (dev) {
  // Vite in middleware mode shares this port, so the app and its HMR websocket
  // live on one origin — no separate dev server, no CORS, no proxy.
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ appType: 'spa', server: { middlewareMode: true, hmr: { server } } })
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuse(res)
    if (handleApi(req, res)) return
    vite.middlewares(req, res, () => { res.statusCode = 404; res.end('not found') })
  })
} else {
  const distDir = path.resolve('dist')
  const types: Record<string, string> = {
    '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  }
  const indexHtml = path.join(distDir, 'index.html')
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    const urlPath = url.pathname
    if (urlPath.startsWith(API_PREFIX) && !allowed(req, url)) return refuse(res)
    if (handleApi(req, res)) return
    const resolved = path.resolve(distDir, '.' + urlPath)
    // Path-traversal guard: never serve outside dist/.
    const file = resolved.startsWith(distDir) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : indexHtml
    const ext = path.extname(file)
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream')
    fs.createReadStream(file).pipe(res)
  })
}

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  // Only /ws is ours; Vite's own HMR upgrade uses a different path, leave it be.
  const url = reqUrl(req)
  if (url.pathname !== WS_PATH) {
    socket.destroy()
    return
  }
  // A WebSocket upgrade is the single most valuable thing on this server to steal — it ends in
  // a PTY. Refuse before `handleUpgrade`, so an unauthorized peer never gets a socket at all.
  if (!allowed(req, url)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
  ws.on('message', (raw) => {
    let msg: ClientMsg
    try { msg = JSON.parse(String(raw)) } catch { return }
    sessions.handle(msg, send)
  })
  ws.on('close', () => sessions.detach(send))
})

server.listen(PORT, HOST, () =>
  // Never print the token itself — only whether one is in force, and how long it is.
  console.log(
    `webterm listening on http://${HOST}:${PORT} (${dev ? 'dev+HMR' : 'prod'}, ` +
      `token ${TOKEN === undefined ? 'off: loopback only' : `on: len=${TOKEN.length}`})`
  )
)
