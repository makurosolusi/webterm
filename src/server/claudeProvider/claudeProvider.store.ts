// Claude provider persistence: config + secret in the 0600 file store (envSecrets.store.ts) under
// `<data dir>/claude-provider`, NOT in webterm.db or settings (both are readable/dumped more widely).
// The data dir is on the agent sandbox's denyRead list (agentSandbox.ts), so agent Bash cannot read it.
// Read on every call (two tiny files): a change applies to the next process started, no cache to bust.
import { join } from 'node:path'
import { dataDir } from '../config'
import { createFileSecretStore, type SecretStore } from '../envSecrets.store'
import { commandProfileExists, commandViewExtras } from './claudeProvider.command'
import { createLogger } from '../logs'
import { proxyEndpoint, serverEnvProviderEnv } from '../credentialProxy/credentialProxy.env'
import type { Upstream } from '../credentialProxy/credentialProxy.types'
import { applyProviderEnv, DEFAULT_CONFIG, isReady, MODES, providerEnv, type ProviderConfig, type ProviderEnv, type ProviderView } from './claudeProvider.model'

export const PROVIDER_SUBDIR = 'claude-provider'
const CONFIG_KEY = 'CONFIG'
const SECRET_KEY = 'SECRET'
export const BACKUP_KEY = 'CONFIG_BAK'

export const providerDir = (): string => join(dataDir(), PROVIDER_SUBDIR)
const defaultStore = (): SecretStore => createFileSecretStore(providerDir())

/** Why the stored config could not be used: the file is not JSON, or not a provider config. */
export type ConfigError = 'unreadable'

const log = createLogger('claude-provider')
/** Raw text of the damaged file already warned about: one warning per damage, not one per spawn. */
let warnedRaw: string | null = null

/** The stored config, or the login default plus `error` when the file is damaged (never silently). */
export function readConfig(store: SecretStore = defaultStore()): { config: ProviderConfig; error?: ConfigError; raw?: string } {
  const raw = store.read(CONFIG_KEY)
  if (!raw) return { config: DEFAULT_CONFIG }
  let c: unknown
  try { c = JSON.parse(raw) } catch { c = undefined } // not JSON: same outcome as a wrong shape, below
  const mode = c && typeof c === 'object' ? (c as { mode?: unknown }).mode : undefined
  if (typeof mode === 'string' && (MODES as readonly string[]).includes(mode)) { warnedRaw = null; return { config: c as ProviderConfig } }
  if (warnedRaw !== raw) {
    warnedRaw = raw
    // No content in the log: the file is the user's own, only its location and the outcome.
    log.warn('claude_provider.config_unreadable', 'Claude provider config is damaged; Claude starts with the Claude Code login until it is reset or saved again', { file: `${PROVIDER_SUBDIR}/${CONFIG_KEY}` })
  }
  return { config: DEFAULT_CONFIG, error: 'unreadable', raw }
}

/** Config every launch uses: a damaged file falls back to the login (never blocks a launch) and is reported by `readConfig`. */
export const loadConfig = (store: SecretStore = defaultStore()): ProviderConfig => readConfig(store).config

/** Keep a damaged config as CONFIG_BAK (same 0600 store) before anything replaces it. */
function backupDamaged(store: SecretStore): void {
  const { error, raw } = readConfig(store)
  if (error && raw !== undefined) store.write(BACKUP_KEY, raw)
}

/** Settings "Reset": back to the login default; a damaged file is kept as CONFIG_BAK, the secret stays. */
export function resetProviderConfig(store: SecretStore = defaultStore()): void {
  backupDamaged(store)
  store.remove(CONFIG_KEY)
}

/** True once a provider choice was saved (any mode, even a damaged file): the user configured Claude. */
export const providerSaved = (store: SecretStore = defaultStore()): boolean => store.read(CONFIG_KEY) !== null

export const loadSecret = (store: SecretStore = defaultStore()): string | null => store.read(SECRET_KEY)

/** Saves config; `secret` undefined = keep, null = remove, string = replace. */
export function saveProvider(config: ProviderConfig, secret: string | null | undefined, store: SecretStore = defaultStore(), now = Date.now()): void {
  if (secret === null) store.remove(SECRET_KEY)
  else if (secret !== undefined) store.write(SECRET_KEY, secret)
  backupDamaged(store)
  store.write(CONFIG_KEY, JSON.stringify({ ...config, updatedAt: now }))
}

export function providerView(store: SecretStore = defaultStore()): ProviderView {
  const { config: c, error } = readConfig(store)
  const secretSet = loadSecret(store) !== null
  return { ...c, secretSet, ready: isReady(c, secretSet, commandProfileExists(c)), ...commandViewExtras(c), ...(error ? { configError: error } : {}) }
}

/** Launch profile id chosen by command mode, or undefined in every other mode (the default-profile override). */
export const commandProfileOverride = (store: SecretStore = defaultStore()): string | undefined => {
  const c = loadConfig(store)
  return c.mode === 'command' && c.profileId ? c.profileId : undefined
}

/** Env change for the next Claude process: the proxy placeholder for a key card (or a login card with a server-env key), else none. */
export function activeProviderEnv(store: SecretStore = defaultStore(), serverEnv: NodeJS.ProcessEnv = process.env): ProviderEnv {
  const c = loadConfig(store)
  if (c.mode === 'login') return serverEnvProviderEnv(serverEnv)
  return providerEnv(c, proxyEndpoint(), loadSecret(store) !== null)
}

/** The one helper every Claude spawn uses: `base` env with the active provider applied. */
export function claudeEnv(base: Record<string, string | undefined>, store?: SecretStore): Record<string, string> {
  return applyProviderEnv(base, activeProviderEnv(store))
}

/** Official API endpoint of an `apiKey` card. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com'

/** `Name: value` lines of ANTHROPIC_CUSTOM_HEADERS. */
function parseHeaderLines(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (raw ?? '').split('\n')) {
    const i = line.indexOf(':')
    if (i > 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** Where the proxy forwards to (the real credential): the card, or the server env while the card is `login`; null = nothing to forward. Only the proxy and the connectivity ping use it. */
export function claudeUpstream(store: SecretStore = defaultStore(), env: NodeJS.ProcessEnv = process.env): Upstream | null {
  const c = loadConfig(store)
  const secret = loadSecret(store)
  if (c.mode === 'apiKey' && secret) return { baseUrl: ANTHROPIC_API_URL, kind: 'xApiKey', secret, headers: {} }
  if (c.mode === 'custom' && secret && c.baseUrl) return { baseUrl: c.baseUrl, kind: c.credential === 'authToken' ? 'bearer' : 'xApiKey', secret, headers: {} }
  if (c.mode !== 'login') return null
  const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
  if (!key) return null
  return { baseUrl: env.ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_API_URL, kind: env.ANTHROPIC_API_KEY ? 'xApiKey' : 'bearer', secret: key, headers: parseHeaderLines(env.ANTHROPIC_CUSTOM_HEADERS) }
}
