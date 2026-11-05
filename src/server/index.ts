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
import { TOKEN_PARAM, authorizeRequest, denyReason, isLoopbackHost, isNodeTokenPath, logAuthLogin, logAuthReject } from './auth'
import { dataDir } from './config'
import { configureLogging, createLogger, flushLogsSync } from './logs'
import { capabilityStore } from './control/mount'
import { isValidNodeToken } from './hooks'
import { activeLedgerRuntime, startLedgerReaper, startLedgerRuntime } from './ledger/ledgerRuntime'
import { buildButtonDeps } from './channels/channelButtons'
import { createTelegramHot, registerTelegramHot } from './channels/telegramHot'
import { buildTelegramCentralPort } from './channels/telegramPollWiring'
import { startCentralAutonomyBoot } from './centralAutonomyBoot'
import { ensureRoutines } from './routines/routinesRuntime'
import { startCostCapture } from './cost/costRuntime'
import { armDagLoop } from './dag/dag.runtime'
import { bootCa2 } from './central/ca2Boot'
import { initEnvSettings } from './envSettings.runtime'
import { bootWiring, onListenError, refuseRequest } from './bootWiring'
import { getTokenState } from './tokenBootstrap'
import { tokenAccessRoute } from './tokenAccess.api'
import { resolveAsset } from './staticAssets'
import { upgradeRoute } from './upgradeRouting'
import { lspUpgrade } from './lsp/lsp.route'
import { WS_ORIGIN_REQUIRED, humanUpgradeOriginOk } from './wsOrigin'
import { BROWSER_WS_PATH } from '../shared/browser.contract'
import { installBrowserAgentShim } from './browserAgentShim'
import { isSafeWorkspaceId } from './browser/profile.paths'
import { activeBrowser, registerBrowserCapability } from './browser/browser.activate'
import { enabledSet, isEnabled, onCapabilityChange, reconcile } from './featureCapabilities.runtime'
import { syncLinkedSettings } from './featureCapabilities.service'
import { createFileSecretStore } from './envSecrets.store'
import { db } from './db'
import { pruneCanvasBackgrounds } from './canvasBackground.gc'
import { backgroundsDir } from './canvasBackground.store'
import { guardWorkspaceRepos } from './repoHygiene'
import { startPortScanner } from './ports/ports.runtime'
import { refuseProxyOnMain, startDevProxy } from './routes/proxy.routes'
import { startWebPush } from './push/push.runtime'
import { registerWorkspaceLookup } from './central/chat/turnPersistence'

// Bun.file di-type lokal (slice sempit) seperti nameGen/pty — @types/bun memerahkan file lain.
declare const Bun: { file(path: string): { arrayBuffer(): Promise<ArrayBuffer> } }

const LOG_DIR = 'logs'
// Host/port, provenance .env, dataDir, token (env > berkas > bangkitkan), allowlist Host — urutannya di bootWiring.ts.
// Berhenti di sini (PORT ngawur / berkas token rusak) sebelum PTY, kanal, atau pengaturan hidup.
const { host: HOST, port: PORT, hosts: HOSTS } = bootWiring(process.env, process.cwd())
// Pengaturan > env > default: terapkan override tersimpan ke process.env sebelum ledger/kanal membacanya.
const envSettings = initEnvSettings()
// After env overrides are applied: level / buffer / file sink come from WEBTERM_LOG_*.
configureLogging({ dir: join(dataDir(), LOG_DIR) })
const log = createLogger('server')
// Kartu Worker/Otonomi yang sudah on sebelum nilai turunannya ada: isi sekarang, tanpa toggle ulang (zero-config).
// Gagal (mis. Pengaturan dikunci) tidak menghentikan boot: kartu tetap bisa dimatikan-nyalakan.
try {
  const linked = syncLinkedSettings(envSettings, process.env)
  if (linked.length > 0) log.info('capabilities.linked_synced', 'Applied card-linked settings for capabilities already on', { keys: linked })
} catch (err) {
  log.warn('capabilities.linked_sync_failed', 'Cannot apply card-linked settings at boot', { error: err instanceof Error ? err.message : String(err) })
}
const dev = process.env.NODE_ENV !== 'production'

// Flag off by default. `shadow` never blocks boot; `on` refuses to start on a broken ledger.
const ledgerRuntime = startLedgerRuntime()
// Workspaces live in webterm.db, never the ledger file: project chats, node.list, browser tools and
// project.discover resolve them through this store.
registerWorkspaceLookup((id) => db.get(id), () => db.list())
if (ledgerRuntime) {
  createLogger('ledger').info('ledger.start', `Ledger ${ledgerRuntime.mode}`, { mode: ledgerRuntime.mode, file: basename(ledgerRuntime.path) })
  startLedgerReaper(ledgerRuntime.ledger)
}

// Telegram hot-apply: runtime kanal + poller dibangun/dihentikan hook kemampuan `telegram`, bukan di boot;
// token tak dibaca di sini. Opsi berupa getter agar tiap start memakai flag central terbaru.
const telegramHot = createTelegramHot({
  ledger: () => activeLedgerRuntime()?.ledger,
  options: {
    get centralChat() { return buildTelegramCentralPort(activeLedgerRuntime()) },
    get buttons() { const rt = activeLedgerRuntime(); return rt ? buildButtonDeps(rt.db) : null },
  },
})
registerTelegramHot(telegramHot)
// Jembatan central dirakit saat start: central berubah => kanal yang sedang on dirakit ulang (bukan saat boot).
let booted = false
const refreshTelegram = () => (booted && isEnabled('telegram') ? telegramHot.refresh() : undefined)
onCapabilityChange('central', { start: refreshTelegram, stop: refreshTelegram })
// bootCa2 merakit manajer bot sekali; bila telegram sudah on nyalakan lebih dulu supaya `bots` ada.
if (isEnabled('telegram')) await telegramHot.start()

// Central autonomy is a timer over the existing ledger runtime (never a second server); its hook
// starts/stops it by capability. Central Agent v2: tool groups, agent executor, panel routes; its
// liveness probe feeds the autonomy reconciler.
const ca2 = bootCa2({ runtime: activeLedgerRuntime(), sessions, bots: telegramHot.channels?.bots ?? null, settings: () => db.getSettings() })
startCentralAutonomyBoot({ runtime: activeLedgerRuntime(), ...(ca2 ? { agentAlive: ca2.agentAlive } : {}) })
// Schedules and event triggers must fire without the UI open (otherwise the first /api/routines call starts them); never under a test runner.
if (process.env.NODE_ENV !== 'test') {
  try { ensureRoutines() } catch (e) { log.warn('routines.start.failed', 'Cannot start routines at boot', { cause: e instanceof Error ? e.message : String(e) }) }
  // Cost capture listens to agent hooks from the first session; a DAG left active by a restart resumes polling.
  startCostCapture().catch((e: unknown) => log.warn('cost.start.failed', 'Cannot start cost capture at boot', { cause: e instanceof Error ? e.message : String(e) }))
  try { armDagLoop() } catch (e) { log.warn('dag.start.failed', 'Cannot arm the DAG scheduler at boot', { cause: e instanceof Error ? e.message : String(e) }) }
  // Wallpaper GC: overrides of deleted workspaces + image files nothing references (one readdir).
  pruneCanvasBackgrounds(db, new Set(db.list().map((w) => w.id)), backgroundsDir()).catch((e: unknown) => log.warn('canvas-background.prune_failed', 'Cannot prune canvas backgrounds at boot', { cause: e instanceof Error ? e.message : String(e) }))
}

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

// Browser di canvas: hook kemampuan `browser` menyalakan/mematikan runtime tanpa restart; /ws/browser dan
// /api/browser selalu terdaftar dan membaca `activeBrowser()` per panggilan. Opsi sesi PTY dihitung ulang
// tiap perubahan (hook kedua jalan setelah hook runtime). Agent terminal memakai token node-nya sendiri; node
// browser target dicari per panggilan dari edge kabel di workspace (`workspaces`), jadi tanpa capability/restart sesi.
// Shim + skill agent dipasang sekali per proses saat runtime start (`onAgentUse`); sub `browserAgent` off cukup ditolak handler.
let shimInstalled = false
const ensureAgentShim = () => { if (!shimInstalled) { installBrowserAgentShim(); shimInstalled = true } }
registerBrowserCapability({
  env: process.env, webtermPort: PORT, loopbackBind: isLoopbackHost(HOST), onAgentUse: ensureAgentShim,
  dataRoot: dataDir(), secrets: createFileSecretStore(join(dataDir(), 'secrets')), workspaces: () => db.list(),
})
onCapabilityChange('browser', { start: applyPtyOptions, stop: applyPtyOptions })
// Semua hook sudah terpasang: boot = reconcile dari himpunan kosong ke yang on di env (hanya yang on yang jalan).
await reconcile(new Set(), enabledSet(process.env))
booted = true
applyPtyOptions()
void sweepTrashOnBoot() // retensi trash R-11; no-op bila WEBTERM_FILES_MUTATE off
void guardWorkspaceRepos(db.list()) // secrets guard: auto-.gitignore untracked secret files in workspace repos
// Port events must exist without the UI open (otherwise the first GET /api/ports starts it); never under a test runner.
if (process.env.NODE_ENV !== 'test') startPortScanner().catch((e: unknown) => log.warn('ports.start.failed', 'Cannot start port scanner at boot', { cause: e instanceof Error ? e.message : String(e) }))
// Web Push to the /m PWA: a gate must reach a phone that is asleep, so the loop runs without /m open.
if (process.env.NODE_ENV !== 'test') startWebPush().catch((e: unknown) => log.warn('push.start.failed', 'Cannot start web push at boot', { cause: e instanceof Error ? e.message : String(e) }))

const server = http.createServer()
// Dev-server proxy (/proxy/<port>/, /absproxy/<port>/) lives on its OWN port = own origin, so a proxied
// page (arbitrary npm code) cannot read the UI's token. Same bind host; PORT+1 or WEBTERM_PROXY_PORT, busy -> OS port.
startDevProxy({ host: HOST, mainPort: PORT, allowedHosts: HOSTS, env: process.env })
  .catch((e: unknown) => log.warn('proxy.start.failed', 'Cannot start the dev-server proxy', { cause: e instanceof Error ? e.message : String(e) }))

if (dev) {
  // Vite in middleware mode shares this port, so the app and its HMR websocket
  // live on one origin — no separate dev server, no CORS, no proxy.
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ appType: 'spa', server: { middlewareMode: true, hmr: { server, clientPort: PORT } } })
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    // Channel webhook carries its own provider secret, not WEBTERM_TOKEN, so it must be routed
    // before the /api gate. `handle` owns only its exact path.
    if (telegramHot.handle(req, res)) return
    if (refuseProxyOnMain(req, res)) return // 404: the proxy has its own origin (proxy.routes.ts)
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuseRequest(req, res, HOSTS)
    if (tokenAccessRoute(req, res, url.pathname, join(dataDir(), 'secrets'))) return
    // Root-only binding CRUD, after the gate (per-node tokens must never reach it).
    if (telegramHot.handleApi(req, res)) return
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
    if (telegramHot.handle(req, res)) return
    if (refuseProxyOnMain(req, res)) return // 404: the proxy has its own origin (proxy.routes.ts)
    if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) return refuseRequest(req, res, HOSTS)
    if (tokenAccessRoute(req, res, url.pathname, join(dataDir(), 'secrets'))) return
    // Root-only binding CRUD, after the gate (per-node tokens must never reach it).
    if (telegramHot.handleApi(req, res)) return
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
  const route = upgradeRoute(url.pathname, WS_PATH, dev, BROWSER_WS_PATH)
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
  // Human channels (/ws PTY, /ws/browser stream), token-free bind: only a browser-sent Origin proves the caller is the web UI (wsOrigin.ts).
  if (!humanUpgradeOriginOk(req.headers, getTokenState().token !== undefined)) {
    logAuthReject(url.pathname, 'origin')
    socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${WS_ORIGIN_REQUIRED.length}\r\n\r\n${WS_ORIGIN_REQUIRED}`)
    socket.destroy()
    return
  }
  if (getTokenState().token !== undefined) logAuthLogin(url.pathname)
  // Editor language servers: same gates as above; root = the workspace's stored cwd (lsp.route.ts).
  if (route === 'lsp') return lspUpgrade(req, socket, head, url, { workspace: (id) => db.get(id) })
  if (route === 'browser') {
    // Gerbang `allowed()` di atas sama dengan /ws: root token saja, node-token ditolak (path ini tak ada di allowlist node-token).
    const workspaceId = url.searchParams.get('workspaceId')
    const rt = activeBrowser()
    if (!rt || !isSafeWorkspaceId(workspaceId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => rt.gateway(ws, workspaceId))
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
