import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { WS_PATH, type ClientMsg, type ServerMsg } from '../shared/protocol'
import { sessions } from './sessions'
import { handleApi } from './api'

const PORT = Number(process.env.PORT) || 8700
const dev = process.env.NODE_ENV !== 'production'

const server = http.createServer()

if (dev) {
  // Vite in middleware mode shares this port, so the app and its HMR websocket
  // live on one origin — no separate dev server, no CORS, no proxy.
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ appType: 'spa', server: { middlewareMode: true, hmr: { server } } })
  server.on('request', (req, res) => {
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
    if (handleApi(req, res)) return
    const urlPath = new URL(req.url || '/', 'http://x').pathname
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
  if (new URL(req.url || '/', 'http://x').pathname === WS_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
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

server.listen(PORT, () => console.log(`webterm listening on http://127.0.0.1:${PORT} (${dev ? 'dev+HMR' : 'prod'})`))
