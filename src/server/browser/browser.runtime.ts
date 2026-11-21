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
import { agentTabHost, withNewTab } from './browser.agentTabs'
import { withTabs } from './browser.agentTabs.verbs'
import { withLayout } from './browser.agentLayout.verbs'
import { SnapshotStore } from './browserAgent.snapshot'
import { type AgentOpenDeps, openAgentBrowser } from './browser.agentOpen'
import { openProjectBrowser } from './browser.projectOpen'
import { handleBrowserControl } from './browserControl.handler'
import { pauseLeaseOnChallenge } from './browserControl.challenge'
import { handleBrowserApi } from '../browserApi'
import { resolveLinkedBrowser } from './browser.linkedTarget'
import { adaptGatewayHost, agentControlOn, audioOn, cookieImportOn, wakeDiscarded } from './browser.runtime.parts'
import { createVersionProbe } from './browser.runtime.version'
import type { BrowserRuntime } from './browser.state'
import type { Workspace } from '../../shared/workspace'
import { DesignMode } from './design/design.service'
import { designRoute } from './design/design.route'
import { OUTBOX_BODY_MAX_CHARS } from '../outbox/outbox.route'
import type { CanvasPush } from '../canvas/canvasPush'
import type { BrowserProfileStore } from '../db.browserProfile'
import type { BrowserProfilesMsg, LinkOpenedMsg, ViewMsg } from '../../shared/protocol'
import { openLinkInCanvas } from './browser.linkOpen'
import { createProfileWiring } from './browser.runtime.profiles'
import { createDownloadWiring } from './browser.runtime.downloads'
import { createAccountsWiring } from './browser.runtime.accounts'
import { withDownloadIds } from './browserAgent.verbs.downloads'
import { createTabsService, tabPersister } from './browser.runtime.tabs'
import { setActiveProfiles } from './browser.profiles.service'

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
  /** Test: board writer for the agent verb `open` (production: the shared `getCanvasPush()`). */
  canvas?: Pick<CanvasPush, 'add' | 'remove' | 'update' | 'workspaceOfNode'>
  /** Browser profile registry (production: `db.browserProfiles()`); absent = in memory (tests). */
  profiles?: BrowserProfileStore
  /** Push a frame to every open window (profile list/live changes); absent = nobody to tell. */
  broadcast?: (msg: BrowserProfilesMsg | LinkOpenedMsg | ViewMsg) => void
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
  const ttl = Number(env[ENV_BROWSER.cookieTtlDays])
  const vault = createCookieVault({ secrets: d.secrets, baseDir: d.dataRoot, ttlDays: ttl > 0 ? ttl : DEFAULT_COOKIE_TTL_DAYS, now })
  const swept = vault.sweepAll()
  if (swept.failed.length) log.warn('browser.vault', 'Some cookie vault blobs are unreadable', { checked: swept.checked, failed: swept.failed.length })
  const live = new Set<string>()
  const navGuard = createNavigationGuard({ allow: allowLive, allowLoopback, webtermPort: d.webtermPort })
  // Who is signed in per profile (Google, GitHub): checked inside the profile's own Chromium, see docs/decisions/browser-profile-accounts.md.
  const accounts = createAccountsWiring({ env, dataRoot: d.dataRoot, launcher, connect: d.connect, guard: (u) => navGuard.check(u), broadcast: d.broadcast, now })
  const profiles = createProfileWiring({ workspaces: d.workspaces, dataRoot: d.dataRoot, launcher, vault, store: d.profiles, broadcast: d.broadcast, liveNodes: () => live, accounts: accounts.service })
  const leases = new LeaseService(now)
  const cfg = lifecycleConfig(env)
  const canvasPush = async () => d.canvas ?? (await import('../canvas/canvasPush.runtime')).getCanvasPush()
  const downloads = createDownloadWiring({ env, dataRoot: d.dataRoot, now, workspaces: d.workspaces, profileOf: profiles.profileOf })
  const host = new BrowserHost({
    downloads: downloads.deps, launcher, profileOf: profiles.profileOf, guard: toHostGuard(navGuard, denials), connect: d.connect, shields, audio: () => audioOn(env), now, initialDevice: (id) => nodeOf(id)?.device,
    initialTabs: (id) => nodeOf(id)?.tabs, persistTabs: tabPersister(canvasPush), agentDriving: (id) => leases.isDriven(id), tabDiscardMs: cfg.discardMs,
  })
  profiles.bind(host)
  const lifecycle = new BrowserLifecycle({ ...cfg, maxLive: () => lifecycleConfig(env).maxLive, host, driven: (id) => leases.isDriven(id), now })
  const gwHost = adaptGatewayHost(host, lifecycle)
  const hub = createViewerHub(gwHost, leases, (id, v) => lifecycle.setVisible(id, v))
  const unLease = leases.onChange((id) => hub.refreshState(id)) // lease agent berubah: UI ikut tahu
  const sweep = setInterval(() => { for (const id of leases.sweep()) leases.release(id) }, SWEEP_MS)
  sweep.unref()

  const nodeOf = (id: string) => d.workspaces().flatMap((w) => w.nodes).find((n) => n.id === id)
  const agentCwdOf = (id: string) => { const w = d.workspaces().find((x) => x.nodes.some((n) => n.id === id)); return w?.nodes.find((n) => n.id === id)?.cwd ?? w?.cwd }
  const agentOverride = new Map<string, boolean>() // toggle terbaru dari UI menang atas snapshot board yang belum tersimpan
  // Default ON (alat developer): hanya `off` eksplisit di sub-opsi atau toggle node yang mematikan.
  const agentEnv = () => agentControlOn(env)
  const agentAllowed = (id: string) => agentEnv() && (agentOverride.get(id) ?? nodeOf(id)?.agentControl) !== false
  const wake = async (id: string, url: string): Promise<void> => { await wakeDiscarded(host, lifecycle, id, url) }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const pageVerbs = withNewTab(createAgentVerbs({ host: agentTabHost(host), leases, snapshots: new SnapshotStore(), agentAllowed, wake, sleep, now, console: host.console, downloads: host.downloads }), host)
  const verbs = withLayout(withTabs(host.downloads ? withDownloadIds(pageVerbs, host.downloads, now) : pageVerbs, { host, leases, agentAllowed, sleep }), { host, leases, agentAllowed, sleep })
  const versionProbe = createVersionProbe({ acquire: (profileId) => launcher.acquire(profileId), connect: d.connect })
  let liveProfiles = ''
  pauseLeaseOnChallenge(host, leases) // a human check is the user's to do; the agent verbs are refused meanwhile (handleBrowserControl)
  host.onState((s: BrowserState) => {
    if (s.live === 'live') {
      live.add(s.id)
      const ws = d.workspaces().find((w) => w.nodes.some((n) => n.id === s.id))
      if (ws) versionProbe.probe(host.profileOf(s.id) ?? ws.id) // the probed process must be one a node already runs, never a fresh Default
    } else if (live.delete(s.id) && live.size === 0) versionProbe.reset() // tak ada browser hidup: restart berikutnya baca ulang
    const now = [...new Set([...live].map((id) => host.profileOf(id)))].sort().join()
    accounts.onState(s, host.profileOf(s.id))
    if (now !== liveProfiles) { liveProfiles = now; profiles.liveChanged() } // the set of profiles with a running process changed
  })
  const status = () => ({ enabled: true, binFound: d.launcher !== undefined || detectChromium(env, d.exists) !== null, ...(live.size > 0 && versionProbe.get() ? { version: versionProbe.get() } : {}), live: live.size, maxLive: lifecycleConfig(env).maxLive, agentEnabled: agentEnv(), cookieImportEnabled: cookieImportOn(env), audio: audioOn(env) })
  const apiDeps = {
    vault, preview: createCookiePreviewStore(), injector: accounts.wrapInjector(createCookieInjector({ launcher, connect: d.connect })), status,
    lease: { holder: (id: string) => leases.holder(id), takeover: (id: string) => leases.takeover(id), release: (id: string) => leases.release(id) },
    setAgentControl: (id: string, on: boolean) => { agentOverride.set(id, on) },
    profiles: { profiles: profiles.service, ops: profiles.ops, accounts: accounts.service },
    setNodeProfile: (nodeId: string, profileId: string) => profiles.setNodeProfile(host, lifecycle, nodeId, profileId),
    tabs: createTabsService({ host, lifecycle, gwHost, hub, workspaces: d.workspaces, canvas: canvasPush, profileOf: profiles.profileOf }),
    downloads: host.downloads,
    sync: { get: (id: string) => (host.state(id) ? host.syncOn(id) : null), set: (id: string, on: boolean) => host.sync.set(id, on) },
  }
  // Design Mode (G11): human-UI routes under /api/browser/<id>/design, tried before the rest.
  const design = new DesignMode({
    cdp: (id, method, params) => host.cdp(id, method, params), workspaces: d.workspaces, shotDir: `${d.dataRoot}/design`,
    outbox: async () => (await import('../outbox/outboxRuntime')).startOutbox(), bodyMax: OUTBOX_BODY_MAX_CHARS,
  })
  host.onState((s) => { if (s.live === 'discarded') design.forget(s.id) }) // page gone = its injected script is gone too
  d.onAgentUse?.() // shim + skill ada begitu browser hidup; sub-opsi off cukup ditolak handler
  let down = false
  const openDeps: AgentOpenDeps = { canvas: canvasPush, start: (id, workspaceId) => gwHost.open(id, workspaceId), profiles: { resolve: (r, w) => profiles.service.resolve(r, w), list: (w) => profiles.service.list(w) }, profileOfNode: profiles.profileOf }
  // Canvas link capture: a link a terminal opened becomes a tab here (browser.linkOpen.ts); the human's tab cursor moves, never the agent's.
  const linkDeps = {
    guard: (url: string) => navGuard.check(url),
    open: (origin: string) => openAgentBrowser(openDeps, origin, () => true, 'cabled'),
    workspaceOf: (id: string) => d.workspaces().find((w) => w.nodes.some((n) => n.id === id))?.id,
    tabsOf: (id: string) => host.tabsState(id) ?? apiDeps.tabs.get(id)?.state,
    newTab: async (id: string, url: string) => { await apiDeps.tabs.newTab(id, { url }) },
    reuseTab: async (id: string, tabId: string, url: string) => { await apiDeps.tabs.activate(id, tabId); await host.tabApi.navigateTab(id, tabId, url) },
    presetOf: (id: string) => nodeOf(id)?.preset,
    notify: (msg: LinkOpenedMsg | ViewMsg) => d.broadcast?.(msg),
  }
  return {
    status,
    state: (id) => host.state(id),
    tabs: (id) => host.tabsState(id),
    listDomains: (workspaceId) => vault.listDomains(workspaceId),
    releaseLease: (id) => leases.release(id),
    async closeNode(id) {
      lifecycle.forget(id)
      host.sync.forget(id)
      leases.release(id)
      agentOverride.delete(id)
      profiles.forget(id)
      accounts.forgetNode(id)
      await host.discard(id)
    },
    gateway: (ws, workspaceId) => handleBrowserConnection(ws, { host: adaptGatewayHost(host, lifecycle), leases, hub, enabled: () => !down, workspaceId, initialUrl: (id) => nodeOf(id)?.url, hintProfile: profiles.hint, onCapacity: (cb) => lifecycle.onCapacity(cb) }),
    api: async (method, pathname, body, search) => (await designRoute(method, pathname, body, design)) ?? handleBrowserApi(method, pathname, body, apiDeps, search),
    control: (req, capabilities) => handleBrowserControl(req, {
      capabilities, verbs, agentAllowed, linked: (who, wanted) => resolveLinkedBrowser(d.workspaces(), who, wanted),
      open: openDeps, presetOf: (id) => nodeOf(id)?.preset, challengeOf: (id) => host.state(id)?.challenge, cwdOf: agentCwdOf,
    }),
    openLink: (originId, url) => openLinkInCanvas(linkDeps, originId, url),
    openFor: (requesterId, nodeId, profile) => openAgentBrowser({ ...openDeps, newId: () => nodeId }, requesterId, agentAllowed, 'cabled', profile),
    openProject: async (workspaceId, nodeId, profile) => {
      const wanted = profile === undefined ? undefined : profiles.service.resolve(profile, workspaceId)
      if (profile !== undefined && !wanted) return { ok: false, code: 'profile_not_found' }
      return openProjectBrowser(openDeps, workspaceId, agentAllowed, nodeId, wanted?.id)
    },
    async shutdown() {
      if (down) return
      down = true
      setActiveProfiles(null)
      clearInterval(sweep); clearInterval(adblockTimer); downloads.stop(); unLease(); lifecycle.dispose(); versionProbe.reset()
      // Tutup halaman satu per satu dulu: stop dari Settings tak boleh meninggalkan tab yatim di Chromium.
      await Promise.all([...live].map((id) => host.discard(id).catch((e) => log.warn('browser.stop', 'page close failed', { error: e instanceof Error ? e.name : typeof e }))))
      await host.dispose().catch((e) => log.warn('browser.stop', 'CDP dispose failed', { error: e instanceof Error ? e.name : typeof e }))
      launcher.shutdown() // Chromium dimatikan SESUDAH koneksi CDP ditutup
      await proxy.close().catch((e) => log.warn('browser.stop', 'proxy close failed', { error: e instanceof Error ? e.name : typeof e }))
    },
  }
}
