// The single composer of the credential-proxy child env (docs/decisions/credential-proxy.md §5):
// a Claude child never holds a real credential, only the proxy URL and a placeholder token.
// Wave 2 connects `setProxyEndpointSource` to the proxy lifecycle.
import { CREDENTIAL_VARS, SCRUB_VAR } from '../agentEnv'
import type { ProxyEndpoint } from './credentialProxy.types'

let source: () => ProxyEndpoint | null = () => null

/** Wires the live proxy endpoint (lifecycle); tests inject a fake one. */
export function setProxyEndpointSource(fn: () => ProxyEndpoint | null): void { source = fn }

/** The running proxy, or null while it is not started. */
export const proxyEndpoint = (): ProxyEndpoint | null => source()

/** Fail closed: a child that needs the proxy never falls back to the real credential. */
export function requireProxy(): ProxyEndpoint {
  const p = source()
  if (!p) throw new Error('credential_proxy_unavailable')
  return p
}

/** The only credential-shaped values a child may hold: placeholder token plus the proxy URL. */
export const proxyChildVars = (p: ProxyEndpoint): Record<string, string> =>
  ({ ANTHROPIC_API_KEY: p.token, ANTHROPIC_BASE_URL: p.url })

/** Server env carries an API credential that the proxy must hold instead of the child. */
export const envHasCredential = (env: NodeJS.ProcessEnv): boolean => !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)

/** Login card + server-env credential: the proxy takes the env as upstream; model vars stay untouched. */
export function serverEnvProviderEnv(env: NodeJS.ProcessEnv): { set: Record<string, string>; unset: string[] } {
  if (!envHasCredential(env)) return { set: {}, unset: [] }
  const set = proxyChildVars(requireProxy())
  return { set, unset: [...CREDENTIAL_VARS, SCRUB_VAR].filter((k) => !(k in set)) }
}
