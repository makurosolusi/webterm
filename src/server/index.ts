import http from 'node:http'
import { basename, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { WS_PATH, type ClientMsg, type ServerMsg } from '../shared/protocol'
import { sessions } from './sessions'
import { fsWatchHub } from './fsWatch'
import { sweepTrashOnBoot } from './fsBoot'
import { filesFlagOn } from './envRegistry.files'
import { applyPtyOptions, handleApi } from './api'
import { installContextLink } from './contextLink'
import { TOKEN_PARAM, authorizeRequest, denyReason, isNodeTokenPath, logAuthLogin, logAuthReject } from './auth'
import { dataDir } from './config'
import { configureLogging, createLogger, flushLogsSync } from './logs'
import { capabilityStore } from './control/mount'
import { isValidNodeToken } from './hooks'
import { activeLedgerRuntime, startLedgerReaper, startLedgerRuntime } from './ledger/ledgerRuntime'
import { buildButtonDeps } from './channels/channelButtons'
import { TELEGRAM_WEBHOOK_PATH, startChannelsRuntime } from './channels/channelsRuntime'
import { buildTelegramCentralPort, resolveTelegramMode, startTelegramInbound } from './channels/telegramPollWiring'
import { startCentralAutonomyBoot } from './centralAutonomyBoot'
import { bootCa2 } from './central/ca2Boot'
import { initEnvSettings } from './envSettings.runtime'
import { bootWiring, onListenError, refuseRequest } from './bootWiring'
import { getTokenState } from './tokenBootstrap'
import { tokenAccessRoute } from './tokenAccess.api'
import { resolveAsset } from './staticAssets'
import { upgradeRoute } from './upgradeRouting'
import { BROWSER_WS_PATH } from '../shared/browser.contract'
import { installBrowserAgentShim } from './browserAgentShim'
import { isSafeWorkspaceId } from './browser/profile.paths'
import { startBrowserRuntime } from './browser/browser.runtime'
import { activeBrowser, setActiveBrowser } from './browser/browser.state'
import { createFileSecretStore } from './envSecrets.store'
import { db } from './db'

// Bun.file di-type lokal (slice sempit) seperti nameGen/pty — @types/bun memerahkan file lain.
declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } }

const LOG_DIR = 'logs'
// Host/port, provenance .env, dataDir, token (env > berkas > bangkitkan), allowlist Host — urutannya di bootWiring.ts.
// Berhenti di sini (PORT ngawur / berkas token rusak) sebelum PTY, kanal, atau pengaturan hidup.
const { host: HOST, port: PORT, hosts: HOSTS } = bootWiring(process.env, process.cwd())
// Pengaturan > env > default: terapkan override tersimpan ke process.env sebelum ledger/kanal membacanya.
initEnvSettings()
// After env overrides are applied: level / buffer / file sink come from WEBTERM_LOG_*.
configureLogging({ dir: join(dataDir(), LOG_DIR) })
const log = createLogger('server')
const dev = process.env.NODE_ENV !== 'production'

// Flag off by default. `shadow` never blocks boot; `on` refuses to start on a broken ledger.
const ledgerRuntime = startLedgerRuntime()
if (ledgerRuntime) {
  createLogger('ledger').info('ledger.start', `Ledger ${ledgerRuntime.mode}`, { mode: ledgerRuntime.mode, file: basename(ledgerRuntime.path) })
  startLedgerReaper(ledgerRuntime.ledger)
}

// Channel ingress is off by default: `WEBTERM_TELEGRAM=on` + webhook secret + a live ledger.
// `null` means no route exists at all, not a route that rejects every request.
const activeRuntime = activeLedgerRuntime()
const centralChat = buildTelegramCentralPort(activeRuntime)
const channelsRuntime = startChannelsRuntime(activeRuntime?.ledger, { centralChat, buttons: activeRuntime ? buildButtonDeps(activeRuntime.db) : null })
if (channelsRuntime && activeRuntime) {
  if (resolveTelegramMode() === 'poll') {
    // Poll mode never exposes a reachable webhook; the route stays mounted but nothing calls it.
    if (startTelegramInbound({ channels: channelsRuntime, ledger: activeRuntime, centralChat })) {
      createLogger('channels.telegram').info('channels.start', 'Telegram channel on (mode=poll)', { mode: 'poll' })
    }
  } else {
    createLogger('channels.telegram').info('channels.start', `Telegram channel on (POST ${TELEGRAM_WEBHOOK_PATH})`, { mode: 'webhook' })
  }
}

// Central autonomy (off by default) is a timer over the existing ledger runtime; it never
// starts a second server. Boot is fail-closed: it logs one line and starts only when
// WEBTERM_CENTRAL_AUTONOMY=on, a ledger runtime exists, and WEBTERM_ORCHESTRATOR_RUN=on.
// Central Agent v2 (every flag off = null, nothing below changes): tool groups, agent executor,
// panel routes; its liveness probe feeds the autonomy reconciler.
const ca2 = bootCa2({ runtime: activeLedgerRuntime(), sessions, bots: channelsRuntime?.bots ?? null, settings: () => db.getSettings() })
startCentralAutonomyBoot({ runtime: activeLedgerRuntime(), ...(ca2 ? { agentAlive: ca2.agentAlive } : {}) })

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
  const expectedToken = getTokenState().token // dibaca per request: enable/rotate token berlaku seketika
  const ok = authorizeRequest({
    headers: req.headers,
    expectedToken,
    queryToken: url.searchParams.get(TOKEN_PARAM),
    pathname: url.pathname,
    allowedHosts: HOSTS,
    isNodeToken: isValidNodeToken,
    // Capability (wcap_*) hanya diterima authorizeRequest pada keluarga /api/control/*.
    // `verify` adalah method pada modul-const, jadi tidak ada siklus bootstrap saat init.
    isCapabilityToken: (t) => capabilityStore.verify(t) !== undefined,
  })
  if (!ok) logAuthReject(url.pathname, denyReason(req.headers, expectedToken, url.searchParams.get(TOKEN_PARAM), HOSTS), req.headers.host)
  return ok
}

export { isNodeTokenPath }

// Write the context-link sh shim AND the skill that points an agent at it. Tanpa argumen: shim
// membaca token node dari env anak saat runtime, jadi root token tidak pernah ditulis ke disk
// (file itu terbaca semua proses dengan uid yang sama).
installContextLink()

// Browser di canvas: flag off (default) => `startBrowserRuntime` mengembalikan null dan tidak ada yang
// dipasang (tanpa jalur /ws/browser, /api/browser, /api/control/browser, tanpa env capability di PTY).
// Dimulai SEBELUM `applyPtyOptions` supaya hook capability sesi ikut terpasang pada opsi sesi pertama.
const browserRuntime = await startBrowserRuntime({
  env: process.env,
  webtermPort: PORT,
  dataRoot: dataDir(),
  secrets: createFileSecretStore(join(dataDir(), 'secrets')),
  capabilities: capabilityStore,
  workspaces: () => db.list(),
})
setActiveBrowser(browserRuntime)
if (browserRuntime) {
  if (browserRuntime.status().agentEnabled) installBrowserAgentShim()
  log.info('browser.start', 'Browser nodes on', { maxLive: browserRuntime.status().maxLive })
}
applyPtyOptions()
void sweepTrashOnBoot() // retensi trash R-11; no-op bila WEBTERM_FILES_MUTATE off

const server = http.createServer()

if (dev) {
  // Vite in middleware mode shares this port, so the app and its HMR websocket
  // live on one origin — no separate dev server, no CORS, no proxy.
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ appType: 'spa', server: { middlewareMode: true, hmr: { server, clientPort: PORT } } })
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    // Channel webhook carries its own provider secret, not WEBTERM_TOKEN, so it must be routed
    // before the /api gate. `handle` owns only its exact path.
    if (channelsRuntime?.handle(req, res)) return
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuseRequest(req, res, HOSTS)
    if (tokenAccessRoute(req, res, url.pathname, join(dataDir(), 'secrets'))) return
    // Root-only binding CRUD, after the gate (per-node tokens must never reach it).
    if (channelsRuntime?.handleApi(req, res)) return
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
    // Channel webhook carries its own provider secret, not WEBTERM_TOKEN, so it must be routed
    // before the /api gate. `handle` owns only its exact path.
    if (channelsRuntime?.handle(req, res)) return
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuseRequest(req, res, HOSTS)
    if (tokenAccessRoute(req, res, url.pathname, join(dataDir(), 'secrets'))) return
    // Root-only binding CRUD, after the gate (per-node tokens must never reach it).
    if (channelsRuntime?.handleApi(req, res)) return
    if (handleApi(req, res)) return
    const hit = resolveAsset(url.pathname, assets)
    if (!hit) { res.statusCode = 404; res.end('not found'); return }
    res.setHeader('Content-Type', hit.contentType)
    Bun.file(hit.assetPath).arrayBuffer().then((buf) => res.end(Buffer.from(buf)))
  })
}

const wss = new WebSocketServer({ noServer: true })
const browserWss = new WebSocketServer({ noServer: true }) // terpisah: handler 'connection' PTY tidak boleh melihat socket browser
server.on('upgrade', (req, socket, head) => {
  // Only /ws is ours. In dev Vite's upgrade listener (same server) already claimed its HMR upgrade,
  // so destroying the socket here would kill it; only prod, with no other listener, destroys.
  const url = reqUrl(req)
  const route = upgradeRoute(url.pathname, WS_PATH, dev, browserRuntime ? BROWSER_WS_PATH : undefined)
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
  if (getTokenState().token !== undefined) logAuthLogin(url.pathname)
  if (route === 'browser') {
    // Gerbang `allowed()` di atas sama dengan /ws: root token saja, node-token ditolak (path ini tak ada di allowlist node-token).
    const workspaceId = url.searchParams.get('workspaceId')
    if (!browserRuntime || !isSafeWorkspaceId(workspaceId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => browserRuntime.gateway(ws, workspaceId))
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  const wsLog = createLogger('ws')
  wsLog.info('ws.connect', 'WebSocket client connected', { clients: wss.clients.size })
  const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
  ws.on('message', (raw) => {
    let msg: ClientMsg
    try { msg = JSON.parse(String(raw)) } catch { return }
    try {
      // fswatch/fsunwatch tidak lewat sessions (bukan sesi PTY); flag WATCH mati = diabaikan.
      if (msg.t === 'fswatch' || msg.t === 'fsunwatch') {
        if (filesFlagOn('WATCH') && typeof msg.dir === 'string') fsWatchHub[msg.t === 'fswatch' ? 'watch' : 'unwatch'](send, msg.dir)
      } else sessions.handle(msg, send)
    } catch (err) {
      wsLog.error('ws.error', `WebSocket message handling failed (t=${msg?.t})`, { error: err })
    }
  })
  ws.on('close', (code, reason) => {
    sessions.detach(send)
    fsWatchHub.dropClient(send)
    wsLog.info('ws.disconnect', 'WebSocket client disconnected', { code, reason: reason.toString().slice(0, 120) })
  })
})

server.on('error', onListenError(HOST, PORT))
server.listen(PORT, HOST, () => {
  // Never log the token itself — only whether one is in force, how long it is, and where it came from.
  const { token: TOKEN, source } = getTokenState()
  const token = TOKEN === undefined ? 'off: loopback only' : `on: len=${TOKEN.length}`
  log.info('server.start', `webterm listening on http://${HOST}:${PORT} (${dev ? 'dev+HMR' : 'prod'}, token ${token}, source ${source})`, {
    host: HOST, port: PORT, mode: dev ? 'dev' : 'prod', dataDir: basename(dataDir()), authRequired: TOKEN !== undefined,
  })
})

// Observe-only crash hook (does not change crash behaviour) + synchronous flush on every exit path.
process.on('uncaughtExceptionMonitor', (err) => log.error('server.error', `Uncaught exception: ${err.name}: ${err.message}`))
process.on('exit', (code) => { log.info('server.stop', 'webterm stopping', { code }); flushLogsSync() })
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  // Chromium + proxy dimatikan bersih (batas 5 dtk) sebelum proses keluar; tanpa runtime browser = perilaku lama.
  process.on(signal, () => {
    const rt = activeBrowser()
    if (!rt) return process.exit(exitCode)
    Promise.race([rt.shutdown(), new Promise((r) => setTimeout(r, 5000))]).finally(() => process.exit(exitCode))
  })
}
