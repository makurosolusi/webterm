// Profile wiring of the browser runtime: the registry service, the disk/process operations and the single node -> profile
// rule (`resolveProfileId`) that launch, wake, cookie inject, the version probe and the agent verb all go through.
import { createMemoryProfileStore } from '../db.browserProfile'
import type { BrowserProfileStore } from '../db.browserProfile'
import { BROWSER_PROFILES_EVENT, isBrowserProfileId, resolveProfileId } from '../../shared/browser.profile'
import type { BrowserProfilesMsg } from '../../shared/protocol'
import type { Workspace } from '../../shared/workspace'
import { activeLedgerRuntime } from '../ledger/ledgerRuntimeState'
import { createLogger } from '../logs'
import type { BrowserHost } from './browserHost.service'
import type { BrowserLifecycle } from './browserLifecycle.service'
import type { BrowserLauncher } from './chromium.launch'
import type { CookieVault } from './cookieVault.store'
import type { AccountsService } from './browser.accounts.service'
import type { ProfileOpsDeps } from './browser.profiles.ops'
import { createProfilesService, err, nodeProfileIdsOf, ok, setActiveProfiles } from './browser.profiles.service'
import type { ProfileActor, ProfileResult, ProfilesService } from './browser.profiles.service'

const log = createLogger('browser.profiles')
const LEDGER_KIND = 'browser.profile'

export interface ProfileWiringDeps {
  workspaces(): Workspace[]
  dataRoot: string
  launcher: BrowserLauncher
  vault: CookieVault
  /** Registry table (production: `db.browserProfiles()`); absent = in memory. */
  store?: BrowserProfileStore
  broadcast?: (msg: BrowserProfilesMsg) => void
  /** Node ids with a live page (for `live` when the launcher cannot say). */
  liveNodes(): Iterable<string>
  /** Signed-in accounts per profile (the account check service); absent = none shown. */
  accounts?: Pick<AccountsService, 'get' | 'forget'>
}

export interface ProfileWiring {
  service: ProfilesService
  ops: ProfileOpsDeps
  /** The one rule: UI switch not yet saved on the board > node's own `profileId` > the workspace's Default. */
  profileOf(nodeId: string, workspaceId: string): string
  /**
   * A viewer's claim that a node was created on `profileId`. Honoured only while the node is not on the saved board yet
   * (the client saves 400 ms after creating it, the attach comes first) and only for a profile this board may use.
   */
  hint(nodeId: string, workspaceId: string, profileId: string): void
  /** Forget a removed node's pending switch. */
  forget(nodeId: string): void
  /** Tell every window the live set may have changed (cheap: windows refetch the list). */
  liveChanged(): void
  /** Host the live-process fallback reads node profiles from; set once the host exists. */
  bind(host: BrowserHost): void
  setNodeProfile(host: BrowserHost, lifecycle: BrowserLifecycle, nodeId: string, profileId: string, by?: ProfileActor): Promise<ProfileResult<{ profileId: string }>>
}

export function createProfileWiring(d: ProfileWiringDeps): ProfileWiring {
  const override = new Map<string, string>() // latest UI choice wins over a board snapshot that is not saved yet (like agentControl)
  const nodeOf = (id: string) => d.workspaces().flatMap((w) => w.nodes).find((n) => n.id === id)
  const profileOf = (nodeId: string, workspaceId: string): string => override.get(nodeId) ?? resolveProfileId(workspaceId, nodeOf(nodeId))
  let hostRef: BrowserHost | null = null
  const isLive = (id: string): boolean => d.launcher.isLive?.(id) ?? [...d.liveNodes()].some((n) => hostRef?.profileOf(n) === id)
  const changed = (): void => d.broadcast?.({ t: BROWSER_PROFILES_EVENT })
  const note = (text: string, by: ProfileActor): void => {
    if (by !== 'agent') return
    try {
      activeLedgerRuntime()?.ledger.event.appendEvent({ actor: 'central', kind: LEDGER_KIND, payload: { text } })
    } catch (e) {
      log.warn('browser.profiles.note', 'ledger note for a profile change failed', { error: e instanceof Error ? e.name : typeof e })
    }
  }
  const service = createProfilesService({
    store: d.store ?? createMemoryProfileStore(), workspaces: d.workspaces, vault: d.vault, isLive, changed, note, accounts: d.accounts ? (id) => d.accounts?.get(id) ?? [] : undefined,
    nodeProfileIds: () => nodeProfileIdsOf(d.workspaces(), (id) => override.get(id)),
  })
  setActiveProfiles(service)
  service.ensureDefaults()
  const ops: ProfileOpsDeps = { svc: service, vault: d.vault, dataRoot: d.dataRoot, stop: (id) => d.launcher.stop?.(id), onRemoved: (id) => d.accounts?.forget(id) }
  return {
    service, ops, profileOf, liveChanged: changed,
    bind: (host) => { hostRef = host },
    hint(nodeId, workspaceId, profileId) {
      if (override.has(nodeId) || nodeOf(nodeId) || !isBrowserProfileId(profileId)) return
      const row = service.deps.store.get(profileId)
      if (row && (row.workspaceId === null || row.workspaceId === workspaceId)) override.set(nodeId, profileId)
    },
    forget: (id) => { override.delete(id) },
    async setNodeProfile(host, lifecycle, nodeId, profileId, by = 'human') {
      const row = isBrowserProfileId(profileId) ? service.deps.store.get(profileId) : null
      const ws = d.workspaces().find((w) => w.nodes.some((n) => n.id === nodeId))
      if (!row) return err('profile_not_found')
      if (!ws || (row.workspaceId !== null && row.workspaceId !== ws.id)) return err('bad_request')
      const wasOn = profileOf(nodeId, ws.id)
      override.set(nodeId, profileId)
      const st = host.state(nodeId)
      if (wasOn !== profileId && st && st.live !== 'discarded') {
        // Move the page: close it in the old process, reopen on the same URL in the new profile's process.
        await host.discard(nodeId)
        const r = await lifecycle.attach(nodeId, ws.id, st.url || undefined)
        if (!r.ok) log.info('browser.profiles.switch', 'node switched profile; page waits for a free live slot', { ids: { nodeId, profileId } })
        note(`moved browser node ${nodeId} to profile "${row.name}" (page reopened on its last URL)`, by)
      }
      service.deps.changed()
      return ok({ profileId })
    },
  }
}
