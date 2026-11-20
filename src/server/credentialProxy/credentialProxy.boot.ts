// Boot hook of the credential proxy: start it with the card's upstream, connect the child-env endpoint
// source, and tell the user when the stored port had to change (docs/decisions/credential-proxy.md section 3).
// A failed start is logged and leaves the endpoint source empty, so every credentialed spawn fails closed
// with `credential_proxy_unavailable` instead of falling back to the real key.
import { claudeUpstream } from '../claudeProvider/claudeProvider.store'
import { automaticAction, type AutomaticActionDeps } from '../central/automaticAction'
import { createLogger } from '../logs'
import { setProxyEndpointSource } from './credentialProxy.env'
import { startCredentialProxy, stopCredentialProxy } from './credentialProxy.lifecycle'
import type { ProxyEndpoint } from './credentialProxy.types'

const log = createLogger('credential-proxy')

export const portChangedText = (n: number): string =>
  `${n} running agent session${n === 1 ? ' points' : 's point'} at the old proxy address and need${n === 1 ? 's' : ''} a restart.`

export interface BootProxyDeps {
  dataDir: string
  /** Running agent sessions at boot (tmux panes outlive the server), for the notice text. */
  runningSessions: () => number
  notice: AutomaticActionDeps
  /** tmux adoption finishes shortly after boot, so the count is taken after this delay (default 5 s, one shot). */
  noticeDelayMs?: number
}

const NOTICE_DELAY_MS = 5000

/** Starts the proxy; returns the endpoint, or null when it could not start (logged; spawns fail closed). */
export function bootCredentialProxy(d: BootProxyDeps): ProxyEndpoint | null {
  try {
    return startCredentialProxy({
      dataDir: d.dataDir,
      resolveUpstream: () => claudeUpstream(),
      onStarted: (e) => setProxyEndpointSource(() => e),
      onPortChanged: () => {
        setTimeout(() => {
          const n = d.runningSessions()
          if (n > 0) automaticAction(d.notice, { name: 'credential_proxy_port', actor: 'system:credential-proxy', subject: 'credential-proxy', text: portChangedText(n), noticeKey: `auto:credential_proxy_port:${Date.now()}` })
        }, d.noticeDelayMs ?? NOTICE_DELAY_MS).unref()
      },
    })
  } catch (err) {
    log.error('credential_proxy.start_failed', 'Credential proxy could not start; Claude sessions with a stored key will not launch', { cause: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Stops the proxy and drops the endpoint source. */
export async function shutdownCredentialProxy(): Promise<void> {
  await stopCredentialProxy()
  setProxyEndpointSource(() => null)
}
