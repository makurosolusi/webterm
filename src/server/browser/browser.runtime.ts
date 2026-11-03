// Perakitan runtime browser (WS-11): SSRF proxy + Chromium pool + host + lease + lifecycle + vault + gateway.
// Dipanggil sekali saat boot HANYA bila `WEBTERM_BROWSER=on`; flag off = fungsi ini mengembalikan null dan
// tak satu pun modul browser dimuat/dijalankan. Tidak ada nilai cookie/token yang pernah dilog di sini.
import { DEFAULT_COOKIE_TTL_DAYS, ENV_BROWSER } from '../../shared/browser.contract'
import type { BrowserState } from '../../shared/browser.contract'
import { flagOn } from '../envFlag'
import { createLogger } from '../logs'
import type { CdpClient } from './cdp.client'
import { createChromiumPool, resolveBinary } from './chromium.launch'
import type { BrowserLauncher } from './chromium.launch'
import { createNavigationGuard } from './navigation.guard'
import { parseAllowHosts } from './ssrf.allowlist'
import { startSsrfProxy } from './ssrf.proxy'
import { createCookieVault } from './cookieVault.store'
import type { SecretStore } from '../envSecrets.store'
import { createCookiePreviewStore } from './cookieImport.preview'
import { createCookieInjector } from './browser.cookieInjector'
import { toHostGuard } from './browser.guardAdapter'
import { BrowserHost } from './browserHost.service'
import { LeaseService } from './browserLease.service'
import { BrowserLifecycle, lifecycleConfig } from './browserLifecycle.service'
import { createViewerHub } from './browserWs.viewers'
import { handleBrowserConnection } from './browserWs.gateway'
import { createAgentVerbs } from './browserAgent.verbs'
import { SnapshotStore } from './browserAgent.snapshot'
import { handleBrowserControl } from './browserControl.handler'
import { handleBrowserApi } from '../browserApi'
import { createBrowserSessionHook } from './browser.sessionCaps'
import { adaptGatewayHost } from './browser.runtime.parts'
import { createVersionProbe } from './browser.runtime.version'
import type { BrowserRuntime } from './browser.state'
import type { CapabilityStore } from '../control/capabilities'
import type { Workspace } from '../../shared/workspace'

const log = createLogger('browser.runtime')
const SWEEP_MS = 10_000

export interface RuntimeDeps {
  env: Record<string, string | undefined>
  webtermPort: number
  dataRoot: string
  secrets: SecretStore
  capabilities: Pick<CapabilityStore, 'mint' | 'revoke'>
  workspaces(): Workspace[]
  /** Test: peluncur/CDP palsu (produksi: pool Chromium nyata). */
  launcher?: BrowserLauncher
  connect?: (wsUrl: string) => Promise<CdpClient>
  now?: () => number
}

export async function startBrowserRuntime(d: RuntimeDeps): Promise<BrowserRuntime | null> {
  const { env } = d
  if (!flagOn(env[ENV_BROWSER.enabled])) return null
  const allow = parseAllowHosts(env[ENV_BROWSER.allowHosts], d.webtermPort)
  if (!allow.ok) { log.error('browser.start', 'Browser disabled: invalid allow-hosts', { reason: allow.reason }); return null }
  const now = d.now ?? Date.now
  const proxy = await startSsrfProxy({ allow: allow.hosts, webtermPort: d.webtermPort })
  const launcher = d.launcher ?? createChromiumPool({ env, dataRoot: d.dataRoot, proxyServer: () => `http://127.0.0.1:${proxy.port}` })
  const host = new BrowserHost({ launcher, guard: toHostGuard(createNavigationGuard({ allow: allow.hosts, webtermPort: d.webtermPort })), connect: d.connect })
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
  const agentEnv = () => flagOn(env[ENV_BROWSER.agent])
  const agentAllowed = (id: string) => agentEnv() && (agentOverride.get(id) ?? nodeOf(id)?.agentControl === true)
  const verbs = createAgentVerbs({ host, leases, snapshots: new SnapshotStore(), agentAllowed, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now })
  const live = new Set<string>()
  const versionProbe = createVersionProbe({ acquire: (w) => launcher.acquire(w), connect: d.connect })
  host.onState((s: BrowserState) => {
    if (s.live === 'live') {
      live.add(s.id)
      const ws = d.workspaces().find((w) => w.nodes.some((n) => n.id === s.id))
      if (ws) versionProbe.probe(ws.id)
    } else if (live.delete(s.id) && live.size === 0) versionProbe.reset() // tak ada browser hidup: restart berikutnya baca ulang
  })
  const binFound = () => { try { resolveBinary(env); return true } catch { return false } }
  const status = () => ({ enabled: true, binFound: d.launcher !== undefined || binFound(), ...(live.size > 0 && versionProbe.get() ? { version: versionProbe.get() } : {}), live: live.size, maxLive: cfg.maxLive, agentEnabled: agentEnv(), cookieImportEnabled: flagOn(env[ENV_BROWSER.cookieImport]) })
  const apiDeps = {
    vault, preview: createCookiePreviewStore(), injector: createCookieInjector({ launcher, connect: d.connect }), status,
    lease: { holder: (id: string) => leases.holder(id), takeover: (id: string) => leases.takeover(id), release: (id: string) => leases.release(id) },
    setAgentControl: (id: string, on: boolean) => { agentOverride.set(id, on) },
  }
  let down = false
  return {
    status,
    state: (id) => host.state(id),
    listDomains: (workspaceId) => vault.listDomains(workspaceId),
    gateway: (ws, workspaceId) => handleBrowserConnection(ws, { host: adaptGatewayHost(host, lifecycle), leases, hub, enabled: () => !down, workspaceId, initialUrl: (id) => nodeOf(id)?.url }),
    api: (method, pathname, body) => handleBrowserApi(method, pathname, body, apiDeps),
    control: (req, capabilities) => handleBrowserControl(req, { capabilities, verbs, agentAllowed }),
    sessionHook: createBrowserSessionHook({ store: d.capabilities, agentEnabled: agentEnv, workspaces: d.workspaces }),
    async shutdown() {
      if (down) return
      down = true
      clearInterval(sweep); unLease(); lifecycle.dispose(); versionProbe.reset()
      await host.dispose().catch((e) => log.warn('browser.stop', 'CDP dispose failed', { error: e instanceof Error ? e.name : typeof e }))
      launcher.shutdown() // Chromium dimatikan SESUDAH koneksi CDP ditutup
      await proxy.close().catch((e) => log.warn('browser.stop', 'proxy close failed', { error: e instanceof Error ? e.name : typeof e }))
    },
  }
}
