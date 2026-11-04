// Read model for `GET /api/control/effective` (Control panel, F0-c): every behaviour key of the env
// registry plus the WEBTERM_* bootstrap keys, each with its effective value, source, a reason sentence,
// and where (if anywhere) the UI controls it. Pure: callers pass the env-settings state and the env.
// Secrets and bootstrap keys never carry a value, only `set`.
import type { EnvEntryV2, EnvStateV2 } from '../shared/envSettings.contract'
import { detectAgentEngine } from './central/runtime/runtimeDetect'
import { CENTRAL_RUNTIME_FLAG } from './central/runtime/runtimeFlag'
import { CAPABILITY_NAME, DERIVED_FROM, uiWhere } from './effectiveConfig.ui'
import { enabledSet } from './featureCapabilities.runtime'

export type EffectiveSource = 'default' | 'env' | '.env' | 'settings' | 'capability'

export interface EffectiveRow {
  key: string
  label: string
  description: string
  subsystem: string
  kind: string
  /** Effective value; '' for secrets and bootstrap keys (see `set`). */
  value: string
  secret: boolean
  set?: boolean
  default?: string
  source: EffectiveSource
  /** One English sentence: why the value is what it is. */
  reason: string
  /** VS Code "@modified": anything other than the code default. */
  modified: boolean
  /** Where the UI controls this key; null = env-only. */
  ui: string | null
  envOnly: boolean
  bootstrap?: true
  mock?: true
  pendingRestart: boolean
  valid: boolean
}

export interface EffectiveConfig {
  /** Any runtime resolves to the simulated (mock) engine. */
  mock: { active: boolean; keys: string[] }
  rows: EffectiveRow[]
}

export interface EffectiveInput {
  state: EnvStateV2
  env: NodeJS.ProcessEnv
  /** Keys whose process.env value came from a dotenv file (`getDotenvBoot().keys`). */
  dotenvKeys: ReadonlySet<string>
  bootstrapKeys: readonly string[]
}

const SUBSYSTEM: Readonly<Record<string, string>> = {
  ledger: 'Ledger', telegram: 'Telegram', channels: 'Channels', central: 'Central agent', 'central-turn': 'Central agent',
  'central-budget': 'Central agent', 'central-context': 'Central agent', 'central-lab': 'Central agent',
  orchestrator: 'Orchestrator', memory: 'Memory', control: 'Control API', browser: 'Browser', files: 'Files', logs: 'Logs',
}
const BOOTSTRAP_SUBSYSTEM = 'Bootstrap'
const BOOTSTRAP_REASON =
  'Bootstrap-only by design: read from the process environment at start so an agent shell cannot loosen it through the API.'
const MOCK_REASON = 'MOCK: Central replies are simulated, not produced by a real agent.'

const nonEmpty = (v: string | undefined): boolean => v !== undefined && v.trim() !== ''

function sourceOf(e: EnvEntryV2, dotenv: ReadonlySet<string>): EffectiveSource {
  if (e.source === 'override') return DERIVED_FROM.has(e.key) ? 'capability' : 'settings'
  if (e.source === 'env') return dotenv.has(e.key) ? '.env' : 'env'
  return 'default'
}

function reasonOf(e: EnvEntryV2, source: EffectiveSource, ui: string | null, env: NodeJS.ProcessEnv): string {
  const derived = DERIVED_FROM.get(e.key)
  const parts: string[] = []
  if (source === 'capability' && derived) {
    const on = enabledSet(env)
    const state = derived.map((id) => `${CAPABILITY_NAME[id]} ${on.has(id) ? 'on' : 'off'}`).join(', ')
    parts.push(`Derived from the ${derived.map((id) => CAPABILITY_NAME[id]).join(' / ')} card (${state}).`)
  } else if (source === 'settings') {
    parts.push(ui ? `Set in ${ui}.` : 'Stored Settings override (imported from .env or set earlier); no UI switch yet.')
  } else if (source === 'env') {
    parts.push('From the shell environment of the server process.')
  } else if (source === '.env') {
    parts.push('From the .env file in the server folder.')
  } else {
    parts.push(derived ? `Code default; follows the ${derived.map((id) => CAPABILITY_NAME[id]).join(' / ')} card once it is switched.` : 'Code default.')
  }
  if (e.envShadowed) parts.push('The shell value is ignored because Settings overrides it.')
  if (!e.valid) parts.push('The stored value is invalid, so the fallback is used.')
  if (e.pendingRestart) parts.push('Changed; takes effect after a server restart.')
  return parts.join(' ')
}

function rowOf(e: EnvEntryV2, i: EffectiveInput): EffectiveRow {
  const ui = uiWhere(e.key)
  const source = sourceOf(e, i.dotenvKeys)
  const secret = e.kind === 'secret'
  let value = secret ? '' : e.effective
  let reason = reasonOf(e, source, ui, i.env)
  // Unset runtime = auto-detect (Claude Code, then OpenCode, never mock): show what it resolves to.
  if (e.key === CENTRAL_RUNTIME_FLAG && source === 'default') {
    value = `auto (${detectAgentEngine({ ...i.env, [CENTRAL_RUNTIME_FLAG]: undefined })})`
    reason = 'Auto-detected: Claude Code, then OpenCode, then off. Auto never picks the mock engine.'
  }
  const mock = e.key === CENTRAL_RUNTIME_FLAG && e.effective === 'mock'
  if (mock) reason = `${MOCK_REASON} ${reason}`
  return {
    key: e.key, label: e.label, description: e.description, subsystem: SUBSYSTEM[e.group] ?? e.group, kind: e.kind,
    value, secret, ...(secret ? { set: e.secretSet === true } : { default: e.default }),
    source, reason, modified: source !== 'default', ui, envOnly: ui === null,
    ...(mock ? { mock: true as const } : {}), pendingRestart: e.pendingRestart, valid: e.valid,
  }
}

function bootstrapRow(key: string, i: EffectiveInput): EffectiveRow {
  const set = nonEmpty(i.env[key])
  const source: EffectiveSource = !set ? 'default' : i.dotenvKeys.has(key) ? '.env' : 'env'
  return {
    key, label: key, description: 'Bootstrap key (process environment only).', subsystem: BOOTSTRAP_SUBSYSTEM, kind: 'bootstrap',
    value: '', secret: true, set, source, reason: BOOTSTRAP_REASON, modified: set, ui: null, envOnly: true, bootstrap: true,
    pendingRestart: false, valid: true,
  }
}

/** Build the effective-config read model. */
export function buildEffectiveConfig(i: EffectiveInput): EffectiveConfig {
  const rows = [
    ...i.state.entries.map((e) => rowOf(e, i)),
    ...i.bootstrapKeys.filter((k) => k.startsWith('WEBTERM_')).map((k) => bootstrapRow(k, i)),
  ]
  const keys = rows.filter((r) => r.mock).map((r) => r.key)
  return { mock: { active: keys.length > 0, keys }, rows }
}
