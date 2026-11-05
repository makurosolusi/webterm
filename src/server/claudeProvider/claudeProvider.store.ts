// Claude provider persistence: config + secret in the 0600 file store (envSecrets.store.ts) under
// `<data dir>/claude-provider`, NOT in webterm.db or settings (both are readable/dumped more widely).
// The data dir is on the agent sandbox's denyRead list (agentSandbox.ts), so agent Bash cannot read it.
// Read on every call (two tiny files): a change applies to the next process started, no cache to bust.
import { join } from 'node:path'
import { dataDir } from '../config'
import { createFileSecretStore, type SecretStore } from '../envSecrets.store'
import { commandProfileExists, commandViewExtras } from './claudeProvider.command'
import { applyProviderEnv, DEFAULT_CONFIG, isReady, providerEnv, type ProviderConfig, type ProviderEnv, type ProviderView } from './claudeProvider.model'

export const PROVIDER_SUBDIR = 'claude-provider'
const CONFIG_KEY = 'CONFIG'
const SECRET_KEY = 'SECRET'

export const providerDir = (): string => join(dataDir(), PROVIDER_SUBDIR)
const defaultStore = (): SecretStore => createFileSecretStore(providerDir())

export function loadConfig(store: SecretStore = defaultStore()): ProviderConfig {
  const raw = store.read(CONFIG_KEY)
  if (!raw) return DEFAULT_CONFIG
  try {
    const c = JSON.parse(raw) as ProviderConfig
    return c && typeof c === 'object' && typeof c.mode === 'string' ? c : DEFAULT_CONFIG
  } catch {
    return DEFAULT_CONFIG // a hand-broken file falls back to the login, it never blocks a launch
  }
}

export const loadSecret = (store: SecretStore = defaultStore()): string | null => store.read(SECRET_KEY)

/** Saves config; `secret` undefined = keep, null = remove, string = replace. */
export function saveProvider(config: ProviderConfig, secret: string | null | undefined, store: SecretStore = defaultStore(), now = Date.now()): void {
  if (secret === null) store.remove(SECRET_KEY)
  else if (secret !== undefined) store.write(SECRET_KEY, secret)
  store.write(CONFIG_KEY, JSON.stringify({ ...config, updatedAt: now }))
}

export function providerView(store: SecretStore = defaultStore()): ProviderView {
  const c = loadConfig(store)
  const secretSet = loadSecret(store) !== null
  return { ...c, secretSet, ready: isReady(c, secretSet, commandProfileExists(c)), ...commandViewExtras(c) }
}

/** Launch profile id chosen by command mode, or undefined in every other mode (the default-profile override). */
export const commandProfileOverride = (store: SecretStore = defaultStore()): string | undefined => {
  const c = loadConfig(store)
  return c.mode === 'command' && c.profileId ? c.profileId : undefined
}

/** Env change for the next Claude process (login mode: none). */
export function activeProviderEnv(store: SecretStore = defaultStore()): ProviderEnv {
  return providerEnv(loadConfig(store), loadSecret(store))
}

/** The one helper every Claude spawn uses: `base` env with the active provider applied. */
export function claudeEnv(base: Record<string, string | undefined>, store?: SecretStore): Record<string, string> {
  return applyProviderEnv(base, activeProviderEnv(store))
}
