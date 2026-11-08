// Perakitan runtime browser (WS-11): SSRF proxy + Chromium pool + host + lease + lifecycle + vault + gateway.
// Dipanggil lewat `startBrowser` (browser.activate.ts) HANYA bila kemampuan `browser` on; off = null dan
// tak satu pun modul browser dijalankan. Tidak ada nilai cookie/token yang pernah dilog di sini.
import { DEFAULT_COOKIE_TTL_DAYS, ENV_BROWSER } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import { join } from 'node:path'
import { isEnabled } from '../featureCapabilities.runtime'
import { createLogger } from '../logs'
import type { CdpClient } from './cdp.client'
import { createChromiumPool, detectChromium } from './chromium.launch'
import type { BrowserLauncher } from './chromium.launch'
import { createNavigationGuard } from './navigation.guard'
import { parseAllowHosts } from './ssrf.allowlist'
import { startSsrfProxy } from './ssrf.proxy'
import { createCookieVault } from './cookieVault.store'
import type { SecretStore } from '../envSecrets.store'
import { createCookiePreviewStore } from './cookieImport.preview'
import { createCookieInjector } from './browser.cookieInjector'
import { createProxyDenials, toHostGuard } from './browser.guardAdapter'
import { BrowserHost } from './browserHost.service'
import { ADBLOCK_REFRESH_MS, createAdblock } from './adblock.engine'
import type { Adblock } from './adblock.engine'
import { createShieldPolicy } from './adblock.shields'
import { LeaseService } from './browserLease.service'
import { BrowserLifecycle, lifecycleConfig } from './browserLifecycle.service'
import { createViewerHub } from './browserWs.viewers'
import { handleBrowserConnection } from './browserWs.gateway'
import { createAgentVerbs } from './browserAgent.verbs'
import { SnapshotStore } from './browserAgent.snapshot'
import { handleBrowserControl } from './browserControl.handler'
import { handleBrowserApi } from '../browserApi'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import { adaptGatewayHost, agentControlOn, cookieImportOn } from './browser.runtime.parts'
import { createVersionProbe } from './browser.runtime.version'
import type { BrowserRuntime } from './browser.state'
import type { Workspace } from '../../shared/workspace'
import { DesignMode } from './design/design.service'
import { designRoute } from './design/design.route'
import { OUTBOX_BODY_MAX_CHARS } from '../outbox/outbox.route'

const log = createLogger('browser.runtime')
const SWEEP_MS = 10_000

export interface RuntimeDeps {
  env: Record<string, string | undefined>
  webtermPort: number
  /** Webterm bind loopback: localhost dev server boleh dibuka tanpa allowlist (port webterm tetap ditolak). */
  loopbackBind?: boolean
  /** Dipanggil sekali saat runtime start: pemasang shim + skill agent (target dipilih per panggilan, jadi tanpa restart sesi). */
  onAgentUse?: () => void
  dataRoot: string
  secrets: SecretStore
  workspaces(): Workspace[]
  /** Test: peluncur/CDP palsu (produksi: pool Chromium nyata). */
  launcher?: BrowserLauncher
  connect?: (wsUrl: string) => Promise<CdpClient>
  now?: () => number
  /** Test: pemeriksa keberadaan biner Chromium (produksi: existsSync). */
  exists?: (p: string) => boolean
  /** Test: mesin filter tanpa jaringan (produksi: daftar prebuilt, cache di `<dataRoot>/browser/adblock`). */
  adblock?: Adblock
}

export async function startBrowserRuntime(d: RuntimeDeps): Promise<BrowserRuntime | null> {
  const { env } = d
  if (!isEnabled('browser', env)) return null
  const allow = parseAllowHosts(env[ENV_BROWSER.allowHosts], d.webtermPort)
  if (!allow.ok) { log.error('browser.start', 'Browser disabled: invalid allow-hosts', { reason: allow.reason }); return null }
  // Allowlist dibaca ulang dari env tiap cek: tombol "Izinkan host" (Pengaturan) berlaku tanpa restart.
  // Nilai baru yang rusak = tetap pakai yang terakhir valid.
  let allowRaw = env[ENV_BROWSER.allowHosts]
  let allowHosts = allow.hosts
  const allowLive = () => {
    const raw = env[ENV_BROWSER.allowHosts]
    if (raw === allowRaw) return allowHosts
    allowRaw = raw
    const next = parseAllowHosts(raw, d.webtermPort)
    if (next.ok) allowHosts = next.hosts
    else log.warn('browser.allow', 'Ignoring invalid allow-hosts change', { reason: next.reason })
    return allowHosts
  }
  const allowLoopback = d.loopbackBind ?? false
  const now = d.now ?? Date.now
  const denials = createProxyDenials(now)
  const proxy = await startSsrfProxy({ allow: allowLive, allowLoopback, webtermPort: d.webtermPort, onDeny: denials.record })
  const launcher = d.launcher ?? createChromiumPool({ env, dataRoot: d.dataRoot, proxyServer: () => `http://127.0.0.1:${proxy.port}`, exists: d.exists })
  // Shields: zero-config, default ON. Daftar filter dimuat di latar (tak menahan startup) dan disegarkan berkala.
  const adblockDir = join(d.dataRoot, 'browser', 'adblock')
  const adblock = d.adblock ?? createAdblock({ dir: adblockDir })
  void adblock.load()
  const adblockTimer = setInterval(() => { void adblock.load() }, ADBLOCK_REFRESH_MS)
  adblockTimer.unref()
  const shields = createShieldPolicy(adblock, adblockDir)
  const host = new BrowserHost({ launcher, guard: toHostGuard(createNavigationGuard({ allow: allowLive, allowLoopback, webtermPort: d.webtermPort }), denials), connect: d.connect, shields, now, initialDevice: (id) => nodeOf(id)?.device })
  const leases = new LeaseService(now)
  const cfg = lifecycleConfig(env)
  const lifecycle = new BrowserLifecycle({ ...cfg, host, driven: (id) => leases.isDriven(id), now })
  const hub = createViewerHub(adaptGatewayHost(host, lifecycle), leases, (id, v) => lifecycle.setVisible(id, v))
  const unLease = leases.onChange((id) => hub.refreshState(id)) // lease agent berubah: UI ikut tahu
  const sweep = setInterval(() => { for (const id of leases.sweep()) leases.release(id) }, SWEEP_MS)
  sweep.unref()

  const ttl = Number(env[ENV_BROWSER.cookieTtlDays])
  const vault = createCookieVault({ secrets: d.secrets, baseDir: d.dataRoot, ttlDays: ttl > 0 ? ttl : DEFAULT_COOKIE_TTL_DAYS, now })
  const swept = vault.sweepAll()
  if (swept.failed.length) log.warn('browser.vault', 'Some cookie vault blobs are unreadable', { checked: swept.checked, failed: swept.failed.length })

  const nodeOf = (id: string) => d.workspaces().flatMap((w) => w.nodes).find((n) => n.id === id)
  const agentOverride = new Map<string, boolean>() // toggle terbaru dari UI menang atas snapshot board yang belum tersimpan
  // Default ON (alat developer): hanya `off` eksplisit di sub-opsi atau toggle node yang mematikan.
  const agentEnv = () => agentControlOn(env)
  const agentAllowed = (id: string) => agentEnv() && (agentOverride.get(id) ?? nodeOf(id)?.agentControl) !== false
  const verbs = createAgentVerbs({ host, leases, snapshots: new SnapshotStore(), agentAllowed, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now, console: host.console })
  const live = new Set<string>()
  const versionProbe = createVersionProbe({ acquire: (w) => launcher.acquire(w), connect: d.connect })
  host.onState((s: BrowserState) => {
    if (s.live === 'live') {
      live.add(s.id)
      const ws = d.workspaces().find((w) => w.nodes.some((n) => n.id === s.id))
      if (ws) versionProbe.probe(ws.id)
    } else if (live.delete(s.id) && live.size === 0) versionProbe.reset() // tak ada browser hidup: restart berikutnya baca ulang
  })
  const status = () => ({ enabled: true, binFound: d.launcher !== undefined || detectChromium(env, d.exists) !== null, ...(live.size > 0 && versionProbe.get() ? { version: versionProbe.get() } : {}), live: live.size, maxLive: cfg.maxLive, agentEnabled: agentEnv(), cookieImportEnabled: cookieImportOn(env) })
  const apiDeps = {
    vault, preview: createCookiePreviewStore(), injector: createCookieInjector({ launcher, connect: d.connect }), status,
    lease: { holder: (id: string) => leases.holder(id), takeover: (id: string) => leases.takeover(id), release: (id: string) => leases.release(id) },
    setAgentControl: (id: string, on: boolean) => { agentOverride.set(id, on) },
  }
  // Design Mode (G11): human-UI routes under /api/browser/<id>/design, tried before the rest.
  const design = new DesignMode({
    cdp: (id, method, params) => host.cdp(id, method, params), workspaces: d.workspaces, shotDir: `${d.dataRoot}/design`,
    outbox: async () => (await import('../outbox/outboxRuntime')).startOutbox(), bodyMax: OUTBOX_BODY_MAX_CHARS,
  })
  host.onState((s) => { if (s.live === 'discarded') design.forget(s.id) }) // page gone = its injected script is gone too
  d.onAgentUse?.() // shim + skill ada begitu browser hidup; sub-opsi off cukup ditolak handler
  let down = false
  return {
    status,
    state: (id) => host.state(id),
    listDomains: (workspaceId) => vault.listDomains(workspaceId),
    releaseLease: (id) => leases.release(id),
    gateway: (ws, workspaceId) => handleBrowserConnection(ws, { host: adaptGatewayHost(host, lifecycle), leases, hub, enabled: () => !down, workspaceId, initialUrl: (id) => nodeOf(id)?.url }),
    api: async (method, pathname, body) => (await designRoute(method, pathname, body, design)) ?? handleBrowserApi(method, pathname, body, apiDeps),
    control: (req, capabilities) => handleBrowserControl(req, { capabilities, verbs, agentAllowed, linked: (who, wanted) => resolveLinkedBrowser(d.workspaces(), who, wanted) }),
    async shutdown() {
      if (down) return
      down = true
      clearInterval(sweep); clearInterval(adblockTimer); unLease(); lifecycle.dispose(); versionProbe.reset()
      // Tutup halaman satu per satu dulu: stop dari Settings tak boleh meninggalkan tab yatim di Chromium.
      await Promise.all([...live].map((id) => host.discard(id).catch((e) => log.warn('browser.stop', 'page close failed', { error: e instanceof Error ? e.name : typeof e }))))
      await host.dispose().catch((e) => log.warn('browser.stop', 'CDP dispose failed', { error: e instanceof Error ? e.name : typeof e }))
      launcher.shutdown() // Chromium dimatikan SESUDAH koneksi CDP ditutup
      await proxy.close().catch((e) => log.warn('browser.stop', 'proxy close failed', { error: e instanceof Error ? e.name : typeof e }))
    },
  }
}
