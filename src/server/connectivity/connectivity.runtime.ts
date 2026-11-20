// Process-wide handle + boot of the detector. The base URL is the REAL upstream (`claudeUpstream`, else the
// public API), never the local credential proxy address a child sees; the secret of the upstream is not read here.
import type { ServerMsg } from '../../shared/protocol'
import { ANTHROPIC_API_URL, claudeUpstream } from '../claudeProvider/claudeProvider.store'
import { recordEvent } from '../events/producers'
import type { LedgerRuntime } from '../ledger/ledgerRuntime'
import { createLogger } from '../logs'
import { changeEvent, netFrame } from './connectivity.events'
import { createConnectivityService, type ConnectivityService } from './connectivity.service'
import { createEpisodeStore } from './connectivity.store'

let active: ConnectivityService | null = null

/** The detector started in this process, or null (no ledger / not booted). */
export const activeConnectivity = (): ConnectivityService | null => active

/** Test hook: install or forget the process detector. */
export function setActiveConnectivity(svc: ConnectivityService | null): void { active = svc }

/** Starts the detector over the ledger db; stops with the process. No-op without a ledger or when already started. */
export function startConnectivity(deps: { runtime: Pick<LedgerRuntime, 'db'> | null; broadcast: (msg: ServerMsg) => void }): ConnectivityService | null {
  if (!deps.runtime || active) return active
  const log = createLogger('connectivity')
  const svc = createConnectivityService({
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    baseUrl: () => claudeUpstream()?.baseUrl ?? ANTHROPIC_API_URL,
    store: createEpisodeStore(deps.runtime.db, Date.now),
    log,
    onChange: (change) => { recordEvent(changeEvent(change)); deps.broadcast(netFrame(change)) },
  })
  active = svc
  svc.start()
  process.once('exit', () => svc.stop())
  return svc
}
