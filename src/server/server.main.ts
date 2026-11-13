// The server itself, loaded by index.ts only after the CLI gate and the one-server-per-data-dir guard:
// importing this module opens webterm.db, starts the runtimes and binds the port.
import http from 'node:http'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { WS_PATH } from '../shared/protocol'
import { serveTerminalSocket } from './terminalSocket'
import { createServerIdentity, healthRoute } from './health.api'
import { sessions } from './sessions'
import { fsWatchHub } from './fsWatch'
import { sweepTrashOnBoot } from './fsBoot'
import { filesFlagOn } from './envRegistry.files'
import { applyPtyOptions, handleApi } from './api'
import { installContextLink } from './contextLink'
import { authorizeRequest, denyReason, isLoopbackHost, isNodeTokenPath, logAuthLogin, logAuthReject } from './auth'
import { dataDir } from './config'
import { configureLogging, createLogger } from './logs'
import { capabilityStore } from './control/mount'
import { isValidNodeToken } from './hooks'
import { activeLedgerRuntime, startLedgerRuntime } from './ledger/ledgerRuntime'
import { buildButtonDeps } from './channels/channelButtons'
import { createTelegramHot, registerTelegramCentralRefresh, registerTelegramHot } from './channels/telegramHot'
import { buildTelegramCentralPort } from './channels/telegramPollWiring'
import { startCentralAutonomyBoot } from './centralAutonomyBoot'
import { bootCa2 } from './central/ca2Boot'
import { registerCanvasBroadcast, registerCanvasTeardown } from './canvas/canvasPush.runtime'
import { createCanvasTeardown } from './canvas/canvasTeardown'
import { initEnvSettings } from './envSettings.runtime'
import { announceListening, announceSetup, bootWiring, onListenError, refuseRequest } from './bootWiring'
import { getTokenState } from './tokenBootstrap'
import { tokenAccessRoute } from './tokenAccess.api'
import { createUiAuthRoute, revokeOtherSessions } from './routes/auth.routes'
import { RUN_SUBDIR, autoOpenAtBoot, createUiOpener } from './uiOpen'
import { embedHost } from './embedHost'
import { uiSessions } from './uiSession'
import { uiUsers } from './uiUser'
import { ensureSetupCode } from './setupCode'
import { loadAssetManifest, noEmbeddedAssets, resolveAsset, serveAsset } from './staticAssets'
import { requestOrigin } from './staticAssets.origin'
import { installShutdown } from './shutdown'
import { upgradeRoute } from './upgradeRouting'
import { lspUpgrade } from './lsp/lsp.route'
import { WS_ORIGIN_REQUIRED, humanUpgradeOriginOk } from './wsOrigin'
import { BROWSER_WS_PATH } from '../shared/browser.contract'
import { ensureBrowserAgentShim } from './browserAgentShim'
import { isSafeWorkspaceId } from './browser/profile.paths'
import { activeBrowser, registerBrowserCapability } from './browser/browser.activate'
import { enabledSet, isEnabled, onCapabilityChange, reconcile } from './featureCapabilities.runtime'
import { createFileSecretStore } from './envSecrets.store'
import { db } from './db'
import { applyLinkedSettings, migrateStoredSettings } from './bootSettings'
import { startCentralLoops, startDeviceLoops, startLedgerLoops } from './bootLoops'
import { activeAgentChatPool } from './agentChat/agentChat.pool'
import { guardWorkspaceRepos } from './repoHygiene'
import { refuseProxyOnMain, startDevProxy } from './routes/proxy.routes'
import { viteCacheDir } from './serverConfig'
import { registerWorkspaceLookup } from './central/chat/turnPersistence'

const LOG_DIR = 'logs'
// Host/port, provenance .env, dataDir, token (env > berkas > bangkitkan) — urutannya di bootWiring.ts.
// Berhenti di sini (PORT ngawur / berkas token rusak) sebelum PTY, kanal, atau pengaturan hidup.
const { host: HOST, port: PORT } = bootWiring(process.env, process.cwd())
// Pengaturan > env > default: terapkan override tersimpan ke process.env sebelum ledger/kanal membacanya.
const envSettings = initEnvSettings()
// After env overrides are applied: level / buffer / file sink come from WEBTERM_LOG_*.
configureLogging({ dir: join(dataDir(), LOG_DIR) })
const log = createLogger('server')
applyLinkedSettings(envSettings, log) // Worker/Autonomy cards already on get their derived values (bootSettings.ts)
const dev = process.env.NODE_ENV !== 'production'

// Always started (`on`, or `shadow` under WEBTERM_LEDGER_SHADOW). Boot passes no explicit mode, so a ledger
// that cannot open is logged as an error and boot goes on without it (null) instead of refusing to start.
const ledgerRuntime = startLedgerRuntime()
// Workspaces live in webterm.db, never the ledger file: project chats, node.list, browser tools and
// project.discover resolve them through this store.
registerWorkspaceLookup((id) => db.get(id), () => db.list())
migrateStoredSettings(log) // first-run backfill + default Claude profile, once (bootSettings.ts)
if (ledgerRuntime) startLedgerLoops(ledgerRuntime, log) // reaper + the startup changes notice (bootLoops.ts)

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
registerTelegramCentralRefresh(telegramHot, () => isEnabled('central'), () => isEnabled('telegram'))
// bootCa2 merakit manajer bot sekali; bila telegram sudah on nyalakan lebih dulu supaya `bots` ada.
if (isEnabled('telegram')) await telegramHot.start()

// Central autonomy is a timer over the existing ledger runtime (never a second server); its hook
// starts/stops it by capability. Central Agent v2: tool groups, agent executor, panel routes; its
// liveness probe feeds the autonomy reconciler.
const ca2 = bootCa2({ runtime: activeLedgerRuntime(), sessions, bots: telegramHot.channels?.bots ?? null, settings: () => db.getSettings() })
startCentralAutonomyBoot({ runtime: activeLedgerRuntime(), ...(ca2 ? { agentAlive: ca2.agentAlive } : {}) })
startCentralLoops(log) // notices, routines, cost, DAG, wallpaper GC; never under a test runner (bootLoops.ts)

const API_PREFIX = '/api/'
// In-process host (src/native): its window gets the sign-in URL and it may package dist/ elsewhere.
const host = embedHost()
/** Vite's outDir, relative to this file (src/server), not the cwd: `bun src/server/index.ts` runs from anywhere. */
const DIST_DIR = host?.distDir ?? join(import.meta.dirname, '../../dist')
/** bootId + build: sent as the socket `hello` and by GET /api/health (health.api.ts). */
const identity = createServerIdentity({ distDir: DIST_DIR, dev })

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
    pathname: url.pathname,
    isNodeToken: isValidNodeToken,
    // Capability (wcap_*) hanya diterima authorizeRequest pada keluarga /api/control/*.
    // `verify` adalah method pada modul-const, jadi tidak ada siklus bootstrap saat init.
    isCapabilityToken: (t) => capabilityStore.verify(t) !== undefined,
    isUiSession: (v) => uiSessions().verify(v),
  })
  if (!ok) logAuthReject(url.pathname, denyReason(req.headers, expectedToken))
  return ok
}

export { isNodeTokenPath }

// Write the context-link sh shim AND the skill that points an agent at it. Tanpa argumen: shim
// membaca token node dari env anak saat runtime, jadi root token tidak pernah ditulis ke disk
// (file itu terbaca semua proses dengan uid yang sama).
installContextLink()

// Browser on the canvas: started/stopped by the `browser` capability, no restart (browser.activate.ts).
registerBrowserCapability({
  env: process.env, webtermPort: PORT, loopbackBind: isLoopbackHost(HOST), onAgentUse: ensureBrowserAgentShim,
  dataRoot: dataDir(), secrets: createFileSecretStore(join(dataDir(), 'secrets')), workspaces: () => db.list(),
})
onCapabilityChange('browser', { start: applyPtyOptions, stop: applyPtyOptions })
// Semua hook sudah terpasang: boot = reconcile dari himpunan kosong ke yang on di env (hanya yang on yang jalan).
await reconcile(new Set(), enabledSet(process.env))
applyPtyOptions()
void sweepTrashOnBoot() // retensi trash R-11; no-op bila WEBTERM_FILES_MUTATE off
void guardWorkspaceRepos(db.list()) // secrets guard: auto-.gitignore untracked secret files in workspace repos
startDeviceLoops(log) // port scanner + Web Push, without the UI open (bootLoops.ts)

// In-process host: its window loads the sign-in file, never the OS browser.
const RUN_DIR = join(dataDir(), RUN_SUBDIR)
const uiOpener = createUiOpener({ runDir: RUN_DIR, bindHost: HOST, port: PORT, ...(host ? { openFile: host.openFile } : {}) })
const uiAuthRoute = createUiAuthRoute({ sessions: uiSessions, users: uiUsers, opener: uiOpener, token: () => getTokenState().token, dataDir })
announceSetup(() => ensureSetupCode(dataDir())) // no account yet: one line naming the setup-code file
const onTokenInstalled = revokeOtherSessions(uiSessions) // token enable/rotate signs every other tab out

/** Every non-asset route, shared by dev and prod; true = the request is answered. */
function routeApp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  // Channel webhook: own provider secret, not WEBTERM_TOKEN, so before the /api gate (`handle` owns its exact path).
  if (telegramHot.handle(req, res)) return true
  if (refuseProxyOnMain(req, res)) return true // 404: the proxy has its own origin (proxy.routes.ts)
  if (uiAuthRoute(req, res, url)) return true // before the gate: this is how a browser gets a credential
  if (url.pathname.startsWith(API_PREFIX) && !allowed(req, url)) { refuseRequest(res); return true }
  if (healthRoute(req, res, url.pathname, identity)) return true
  if (tokenAccessRoute(req, res, url.pathname, join(dataDir(), 'secrets'), onTokenInstalled)) return true
  return telegramHot.handleApi(req, res) || handleApi(req, res) // root-only, after the gate: per-node tokens never reach it
}

const server = http.createServer()
// Dev-server proxy (/proxy/<port>/, /absproxy/<port>/) lives on its OWN port = own origin, so a proxied
// page (arbitrary npm code) cannot read the UI's token. Same bind host; PORT+1 or WEBTERM_PROXY_PORT, busy -> OS port.
const devProxy = startDevProxy({ host: HOST, mainPort: PORT, env: process.env })
  .catch((e: unknown) => { log.warn('proxy.start.failed', 'Cannot start the dev-server proxy', { cause: e instanceof Error ? e.message : String(e) }); return null })

if (dev) {
  // Vite in middleware mode shares this port, so the app and its HMR websocket
  // live on one origin — no separate dev server, no CORS, no proxy.
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({ appType: 'spa', cacheDir: viteCacheDir(process.env), server: { middlewareMode: true, hmr: { server, clientPort: PORT } } })
  server.on('request', (req, res) => {
    if (!routeApp(req, res, reqUrl(req))) vite.middlewares(req, res, () => { res.statusCode = 404; res.end('not found') })
  })
} else {
  // dist/ on disk first (plain `vite build`), else the manifest embedDist.ts embeds into a `--compile`
  // binary. The generated module is gitignored, so a fresh tree has none: only that case is absorbed.
  const { assets } = await loadAssetManifest(DIST_DIR, () => import('./distAssets.generated').then((m) => m.assets, noEmbeddedAssets))
  server.on('request', (req, res) => {
    const url = reqUrl(req)
    if (routeApp(req, res, url)) return
    const hit = resolveAsset(url.pathname, assets)
    if (!hit) { res.statusCode = 404; res.end('not found'); return }
    void serveAsset(res, hit, req.headers['accept-encoding'], requestOrigin(req.headers)) // never rejects: a missing file is a 404 for this request only
  })
}

const wss = new WebSocketServer({ noServer: true })
registerCanvasBroadcast((msg) => {
  const frame = JSON.stringify(msg)
  for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(frame)
})
registerCanvasTeardown(createCanvasTeardown({ sessions, browser: activeBrowser, agentChats: activeAgentChatPool }))
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
  // Human channels (/ws PTY, /ws/browser stream) on the cookie: only a browser-sent Origin proves the caller is the web UI (wsOrigin.ts).
  if (!humanUpgradeOriginOk(req.headers, getTokenState().token)) {
    logAuthReject(url.pathname, 'origin')
    socket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${WS_ORIGIN_REQUIRED.length}\r\n\r\n${WS_ORIGIN_REQUIRED}`)
    socket.destroy()
    return
  }
  logAuthLogin(url.pathname)
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

// Terminal socket dispatch, heartbeat and backpressure live in terminalSocket.ts.
// SSE streams on this socket go through routeApp: the same /api gate and dispatcher as an HTTP request,
// with the upgrade request's own headers (cookie / token / Origin), so a stream is never easier to open.
const streamDispatch = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  if (!routeApp(req, res, reqUrl(req))) { res.statusCode = 404; res.end() }
}
wss.on('connection', (ws, req: http.IncomingMessage) => serveTerminalSocket(ws, {
  sessions, fsWatchHub, identity, watchOn: () => filesFlagOn('WATCH'), clients: () => wss.clients.size,
  streams: { upgrade: req, dispatch: streamDispatch },
}))

let markReady: (bound: { host: string; port: number }) => void = () => {}
/** Resolves once the main listener is bound; for an in-process host (src/native) that imports this module. */
export const ready = new Promise<{ host: string; port: number }>((resolve) => { markReady = resolve })
/** Open a signed-in UI window through the opener (the in-process host's window when one is registered). */
export const openUi = (): Promise<void> => uiOpener.open()

server.on('error', onListenError(HOST, PORT))
server.listen(PORT, HOST, () => {
  markReady({ host: HOST, port: PORT })
  announceListening({ host: HOST, port: PORT, dev, runDir: RUN_DIR, autoOpen: () => {
    // An in-process host opens its own window (openUi), so no auto-open there.
    void autoOpenAtBoot({ sessionCount: () => uiSessions().count(), opener: uiOpener, interactive: !host && process.stderr.isTTY === true })
  } })
})

/** In-process stop (src/native, tests); also installs the exit/signal hooks that close the stores (shutdown.ts). */
export const stopServer = installShutdown({
  log, runDir: RUN_DIR, server, devProxy, sockets: () => [...wss.clients, ...browserWss.clients],
  stores: [['webterm.db', () => db.close()], ...(ledgerRuntime ? [['ledger.db', () => ledgerRuntime.close()] as const] : [])],
})
