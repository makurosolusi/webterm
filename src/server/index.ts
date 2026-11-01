import http from 'node:http'
import { WebSocketServer } from 'ws'
import { WS_PATH, type ClientMsg, type ServerMsg } from '../shared/protocol'
import { sessions } from './sessions'
import { applyPtyOptions, handleApi } from './api'
import { installContextLink } from './contextLink'
import { TOKEN_PARAM, authorizeRequest, isNodeTokenPath, resolveToken, writeTokenToEnv } from './auth'
import { capabilityStore } from './control/mount'
import { isValidNodeToken } from './hooks'
import { startLedgerRuntime } from './ledger/ledgerRuntime'
import { resolveHostPort } from './serverConfig'
import { resolveAsset } from './staticAssets'
import { upgradeRoute } from './upgradeRouting'

// Bun.file di-type lokal (slice sempit) seperti nameGen/pty — @types/bun memerahkan file lain.
declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } }

const { host: HOST, port: PORT } = resolveHostPort(process.env)
// Throws (and so refuses to start) when HOST is reachable off-machine without a token.
const TOKEN = resolveToken(HOST, process.env.WEBTERM_TOKEN)
// Before anything can spawn a PTY: make the env agree with what we enforce, so children that
// reference $WEBTERM_TOKEN inherit the same form `authorize` compares against.
writeTokenToEnv(TOKEN)
const dev = process.env.NODE_ENV !== 'production'

// Flag off by default. `shadow` never blocks boot; `on` refuses to start on a broken ledger.
const ledgerRuntime = startLedgerRuntime()
if (ledgerRuntime) console.log(`ledger ${ledgerRuntime.mode}: ${ledgerRuntime.path}`)

const API_PREFIX = '/api/'

function reqUrl(req: http.IncomingMessage): URL {
  return new URL(req.url || '/', 'http://x')
}

/**
 * Gate for the two surfaces that act on the machine: /api (filesystem, workspaces) and the
 * /ws upgrade (PTYs). Static assets are deliberately NOT gated — the app bundle is not a
 * privilege, and gating it would break every sub-resource request, which carries no token.
 *
 * Root token first, unchanged. Only when that fails does a per-node token open the narrow
 * allowlist in `isNodeTokenPath` (hook status / context-link / control API) — so a PTY child
 * never needs the root token, and everything else (settings, workspaces, fs, /ws) stays
 * root-only. Re-exported for tests; the gate itself lives in auth.ts because importing this
 * module starts a server.
 */
function allowed(req: http.IncomingMessage, url: URL): boolean {
  return authorizeRequest({
    headers: req.headers,
    expectedToken: TOKEN,
    queryToken: url.searchParams.get(TOKEN_PARAM),
    pathname: url.pathname,
    isNodeToken: isValidNodeToken,
    // Capability (wcap_*) hanya diterima authorizeRequest pada keluarga /api/control/*.
    // `verify` adalah method pada modul-const, jadi tidak ada siklus bootstrap saat init.
    isCapabilityToken: (t) => capabilityStore.verify(t) !== undefined,
  })
}

export { isNodeTokenPath }

function refuse(res: http.ServerResponse): void {
  res.statusCode = 403
  res.end('forbidden')
}

// Write the context-link sh shim AND the skill that points an agent at it. Tanpa argumen: shim
// membaca token node dari env anak saat runtime, jadi root token tidak pernah ditulis ke disk
// (file itu terbaca semua proses dengan uid yang sama).
installContextLink()
applyPtyOptions()

const server = http.createServer()

if (dev) {
  // Vite in middleware mode shares this port, so the app and its HMR websocket
  // live on one origin — no separate dev server, no CORS, no proxy.
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ appType: 'spa', server: { middlewareMode: true, hmr: { server, clientPort: PORT } } })
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuse(res)
    if (handleApi(req, res)) return
    vite.middlewares(req, res, () => { res.statusCode = 404; res.end('not found') })
  })
} else {
  // Aset di-embed ke binary saat build (bun `with { type: 'file' }`), bukan dibaca dari dist/ di
  // disk — jadi binary hasil `--compile` jalan sendiri tanpa dist/ di sampingnya. Import dinamis:
  // modul generated ini mungkin belum dibangun di checkout segar / jalur dev tak boleh memaksanya.
  const { assets } = await import('./distAssets.generated')
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuse(res)
    if (handleApi(req, res)) return
    const hit = resolveAsset(url.pathname, assets)
    if (!hit) { res.statusCode = 404; res.end('not found'); return }
    res.setHeader('Content-Type', hit.contentType)
    Bun.file(hit.assetPath).arrayBuffer().then((buf) => res.end(Buffer.from(buf)))
  })
}

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  // Only /ws is ours. In dev Vite's upgrade listener (same server) already claimed its HMR upgrade,
  // so destroying the socket here would kill it; only prod, with no other listener, destroys.
  const url = reqUrl(req)
  const route = upgradeRoute(url.pathname, WS_PATH, dev)
  if (route === 'destroy') {
    socket.destroy()
    return
  }
  if (route === 'ignore') return
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
    try { sessions.handle(msg, send) } catch (err) {
      console.error(`ws message handling failed (t=${msg?.t}):`, err instanceof Error ? err.message : err)
    }
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
