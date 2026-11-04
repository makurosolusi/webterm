// Production wiring of Web Push: the inbox sweep loop and the `hook.*` listener, started once per
// process. Lazy imports keep bun:sqlite and the session registry out of anything that only parses.
import { join } from 'node:path'
import { createLogger } from '../logs'
import { pushStatePath, vapidKeys } from './push.store'
import { hookPushListener, sweepWebPush, WEB_PUSH_INTERVAL_MS, type WebPushDeps } from './push.sweep'

const log = createLogger('push')
let stop: (() => void) | null = null

/** Store + sender deps for the HTTP route (no loop, no listeners). */
export async function productionPushDeps(): Promise<Pick<WebPushDeps, 'statePath' | 'keys' | 'fetch' | 'now'>> {
  const [{ dataDir }, { createFileSecretStore }] = await Promise.all([import('../config'), import('../envSecrets.store')])
  const secrets = createFileSecretStore(join(dataDir(), 'secrets'))
  return { statePath: pushStatePath(dataDir()), keys: () => vapidKeys(secrets), fetch: (...a) => fetch(...a), now: Date.now }
}

/** Starts the loop (idempotent); returns the stop function. */
export async function startWebPush(): Promise<() => void> {
  if (stop) return stop
  const [{ dataDir }, { createFileSecretStore }, { activeLedgerRuntime }, { presence }, { eventBus }, { listInboxItems }, { watchingFrom }, { db }, { workspaceLabels, morningBriefText }] = await Promise.all([
    import('../config'), import('../envSecrets.store'), import('../ledger/ledgerRuntimeState'), import('../channels/channelPresence'),
    import('../events/eventBus'), import('../inbox/inboxItemStore'), import('../inbox/inboxPush'), import('../db'), import('../brief/brief.route'),
  ])
  if (stop) return stop
  const secrets = createFileSecretStore(join(dataDir(), 'secrets'))
  const attention = { watching: (item: { nodeId: string | null }) => watchingFrom(presence, item), muted: (ws: string) => presence.isMuted(ws) }
  const deps: WebPushDeps = {
    statePath: pushStatePath(dataDir()),
    keys: () => vapidKeys(secrets),
    fetch: (...a) => fetch(...a),
    now: Date.now,
    items: () => { const l = activeLedgerRuntime(); return l ? listInboxItems({ db: l.db, now: Date.now }) : null },
    attention,
    awayMs: () => presence.awayMs(),
    briefText: morningBriefText,
  }
  const labels = workspaceLabels(() => db.list())
  const unsubscribe = eventBus.subscribe('hook.*', hookPushListener({ ...deps, label: (id) => labels.nodeLabel(id) }))
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    sweepWebPush(deps)
      .catch((err: unknown) => log.warn('push.sweep_failed', 'web push sweep failed', { cause: err instanceof Error ? err.message : String(err) }))
      .finally(() => { running = false })
  }, WEB_PUSH_INTERVAL_MS)
  timer.unref?.()
  stop = () => { clearInterval(timer); unsubscribe(); stop = null }
  return stop
}
