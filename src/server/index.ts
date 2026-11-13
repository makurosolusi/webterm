// Must stay the first import: CLI flags (--help, --version, ...) exit before any side effect below.
import './cli/cliGate'
import http from 'node:http'
import { basename, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { WS_PATH } from '../shared/protocol'
import { serveTerminalSocket } from './terminalSocket'
import { createServerIdentity, healthRoute } from './health.api'
import { sessions } from './sessions'
import { fsWatchHub } from './fsWatch'
import { createTrashReaper, sweepTrashOnBoot } from './fsBoot'
import { filesFlagOn } from './envRegistry.files'
import { applyPtyOptions, handleApi } from './api'
import { installContextLink } from './contextLink'
import { authorizeRequest, denyReason, isLoopbackHost, isNodeTokenPath, logAuthLogin, logAuthReject } from './auth'
import { dataDir } from './config'
import { configureLogging, createLogger, flushLogsSync } from './logs'
import { capabilityStore } from './control/mount'
import { isValidNodeToken } from './hooks'
import { activeLedgerRuntime, startLedgerReaper, startLedgerRuntime } from './ledger/ledgerRuntime'
import { buildButtonDeps } from './channels/channelButtons'
import { createTelegramHot, registerTelegramHot } from './channels/telegramHot'
import { buildTelegramCentralPort } from './channels/telegramPollWiring'
import { startCentralAutonomyBoot } from './centralAutonomyBoot'
import { bootCentralNotices } from './central/centralNotices'
import { ensureRoutines } from './routines/routinesRuntime'
import { startCostCapture } from './cost/costRuntime'
import { armDagLoop } from './dag/dag.runtime'
import { bootCa2 } from './central/ca2Boot'
import { registerCanvasBroadcast, registerCanvasTeardown } from './canvas/canvasPush.runtime'
import { createCanvasTeardown } from './canvas/canvasTeardown'
import { initEnvSettings } from './envSettings.runtime'
import { announceSetup, bootWiring, onListenError, refuseRequest } from './bootWiring'
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
import { onUnhandledRejection } from './processCrash'
import { closeStores } from './shutdown'
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
import { backfillSetup } from './setupBackfill'
import { flushBootChanges, queueBootChange } from './bootChanges'
import { announceRetentionSweep } from './central/retentionNotice'
import { loadConfig, providerSaved } from './claudeProvider/claudeProvider.store'
import { defaultProfileAfter } from './claudeProvider/claudeProvider.command'
import { pruneCanvasBackgrounds } from './canvasBackground.gc'
import { backgroundsDir } from './canvasBackground.store'
import { guardWorkspaceRepos } from './repoHygiene'
import { startPortScanner } from './ports/ports.runtime'
import { refuseProxyOnMain, startDevProxy } from './routes/proxy.routes'
import { viteCacheDir } from './serverConfig'
import { startWebPush } from './push/push.runtime'
import { registerWorkspaceLookup } from './central/chat/turnPersistence'
import { activeAgentChatPool } from './agentChat/agentChat.pool'

const LOG_DIR = 'logs'
// Host/port, provenance .env, dataDir, token (env > berkas > bangkitkan) — urutannya di bootWiring.ts.
// Berhenti di sini (PORT ngawur / berkas token rusak) sebelum PTY, kanal, atau pengaturan hidup.
const { host: HOST, port: PORT } = bootWiring(process.env, process.cwd())
// Pengaturan > env > default: terapkan override tersimpan ke process.env sebelum ledger/kanal membacanya.
const envSettings = initEnvSettings()
// After env overrides are applied: level / buffer / file sink come from WEBTERM_LOG_*.
configureLogging({ dir: join(dataDir(), LOG_DIR) })
const log = createLogger('server')
// Kartu Worker/Otonomi yang sudah on sebelum nilai turunannya ada: isi sekarang, tanpa toggle ulang (zero-config).
// Gagal (mis. Pengaturan dikunci) tidak menghentikan boot: kartu tetap bisa dimatikan-nyalakan.
try {
  queueBootChange('default_on', envSettings.defaultsApplied())
  const linked = syncLinkedSettings(envSettings, process.env)
  queueBootChange('linked', linked)
  if (linked.length > 0) log.info('capabilities.linked_synced', 'Applied card-linked settings for capabilities already on', { keys: linked })
} catch (err) {
  log.warn('capabilities.linked_sync_failed', 'Cannot apply card-linked settings at boot', { error: err instanceof Error ? err.message : String(err) })
}
const dev = process.env.NODE_ENV !== 'production'

// Always started (`on`, or `shadow` under WEBTERM_LEDGER_SHADOW). Boot passes no explicit mode, so a ledger
// that cannot open is logged as an error and boot goes on without it (null) instead of refusing to start.
const ledgerRuntime = startLedgerRuntime()
// Workspaces live in webterm.db, never the ledger file: project chats, node.list, browser tools and
// project.discover resolve them through this store.
registerWorkspaceLookup((id) => db.get(id), () => db.list())
// Upgrade path for the first-run wizard: an install already in use is marked set up (once, see setupBackfill.ts).
try {
  if (backfillSetup({ storedJson: () => db.storedSettingsJson(), save: (p) => db.saveSettings(p), existingInstall: () => db.listSummaries(1).items.length > 0 || providerSaved() }) === 'completed') queueBootChange('setup', ['setup'])
} catch (e) {
  log.warn('settings.setup.backfill_failed', 'Cannot backfill first-run setup state at boot', { cause: e instanceof Error ? e.message : String(e) })
}
// Command mode's profile is the default for new agents (saved together since the Claude page); an older
// install that saved command mode alone gets the default written once (idempotent: equal = no write).
try {
  const id = defaultProfileAfter({ mode: 'login' }, loadConfig(), db.getSettings().defaultClaudeProfileId)
  if (id !== null) { db.saveSettings({ defaultClaudeProfileId: id }); queueBootChange('profile', ['defaultClaudeProfileId']) }
} catch (e) {
  log.warn('settings.claude_default.migrate_failed', 'Cannot align the default Claude profile with command mode at boot', { cause: e instanceof Error ? e.message : String(e) })
}
if (ledgerRuntime) {
  createLogger('ledger').info('ledger.start', `Ledger ${ledgerRuntime.mode}`, { mode: ledgerRuntime.mode, file: basename(ledgerRuntime.path) })
  startLedgerReaper({ task: ledgerRuntime.ledger.task, retention: ledgerRuntime.ledger.retention, trash: createTrashReaper(), onRetention: (changed) => announceRetentionSweep(changed) })
  try { flushBootChanges(ledgerRuntime.db) } catch (e) { log.warn('boot.changes_notice_failed', 'Cannot post the startup changes notice', { cause: e instanceof Error ? e.message : String(e) }) }
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
// Central is the notification hub with or without Telegram: gate and agent notices land in its chat.
if (process.env.NODE_ENV !== 'test') bootCentralNotices()
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

// In-process host: the sign-in URL goes to its window, never the OS browser.
const uiOpener = createUiOpener({ runDir: join(dataDir(), RUN_SUBDIR), bindHost: HOST, port: PORT, ...(host ? { openFile: (_path: string, url: string) => host.openUrl(url) } : {}) })
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
  // Never log the token itself — only whether one is in force, how long it is, and where it came from.
  const { token: TOKEN, source } = getTokenState()
  const token = TOKEN === undefined ? 'off: loopback only' : `on: len=${TOKEN.length}`
  log.info('server.start', `webterm listening on http://${HOST}:${PORT} (${dev ? 'dev+HMR' : 'prod'}, token ${token}, source ${source})`, {
    host: HOST, port: PORT, mode: dev ? 'dev' : 'prod', dataDir: basename(dataDir()), authRequired: TOKEN !== undefined,
  })
  // An in-process host opens its own window (openUi), so no auto-open there.
  void autoOpenAtBoot({ sessionCount: () => uiSessions().count(), opener: uiOpener, interactive: !host && process.stderr.isTTY === true })
})

// Observe-only crash hook (does not change crash behaviour) + synchronous flush on every exit path.
process.on('uncaughtExceptionMonitor', (err) => log.error('server.error', `Uncaught exception: ${err.name}: ${err.message}`))
// Bun dies on an unhandled rejection but reports exit code 0 to the `exit` hook; log it and exit 1.
process.on('unhandledRejection', onUnhandledRejection(log))
let storesClosed = false
/** Once per process: the `exit` hook, or stopServer() for an in-process host whose runtime may exit natively without it. */
function closeStoresOnce(code: number): void {
  if (storesClosed) return
  storesClosed = true
  closeStores([['webterm.db', () => db.close()], ...(ledgerRuntime ? [['ledger.db', () => ledgerRuntime.close()] as const] : [])], log)
  log.info('server.stop', 'webterm stopping', { code })
  flushLogsSync()
}
process.on('exit', closeStoresOnce)
const BROWSER_SHUTDOWN_CAP_MS = 5000
/** Chat Queries aborted (no Claude child outlives the server), Chromium + proxy closed (capped). */
function releaseRuntimes(): Promise<unknown> {
  activeAgentChatPool()?.closeAll()
  const rt = activeBrowser()
  return rt ? Promise.race([rt.shutdown(), new Promise((r) => setTimeout(r, BROWSER_SHUTDOWN_CAP_MS))]) : Promise.resolve()
}
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  // Chromium + proxy dimatikan bersih (batas 5 dtk) sebelum proses keluar; tanpa runtime browser = perilaku lama.
  process.on(signal, () => { void releaseRuntimes().finally(() => process.exit(exitCode)) })
}

/**
 * In-process stop (src/native, tests): release runtimes, drop every socket, close the main and proxy
 * listeners so both ports are free, then close the stores. Electrobun quits through a native exit that
 * skips the process `exit` hook, so the stores cannot wait for it. The process is expected to exit next.
 */
export async function stopServer(): Promise<void> {
  log.info('server.stop_requested', 'In-process host is stopping webterm')
  await releaseRuntimes()
  for (const c of [...wss.clients, ...browserWss.clients]) c.terminate()
  // close() first, then drop keep-alive sockets: under Bun, closeAllConnections() before close() stops the listener and close() then throws.
  const closed = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(new Error('cannot close the webterm listener', { cause: err })) : resolve())))
  server.closeAllConnections()
  await Promise.all([closed, devProxy.then((p) => p?.close())])
  closeStoresOnce(0)
}
