// Where each env registry key is controlled from the UI (read model for the Control panel, F0-c).
// Pure data over the capability catalog; the A2 drift test checks every registry key against this
// map plus `ENV_ONLY_PENDING_F1`, so a new knob cannot ship hidden behind env alone unnoticed.
import { ENV_BROWSER } from '../shared/browser.contract'
import { CAPABILITIES, CAPABILITY_IDS, DERIVED_FLAGS, LINKED_SETTINGS, type CapabilityId } from '../shared/featureCapabilities'
import { CENTRAL_RUNTIME_FLAG } from './central/runtime/runtimeFlag'

const CAP = 'Settings › Capabilities'

/** English card names (the catalog titles are still Indonesian; product text is English). */
export const CAPABILITY_NAME: Readonly<Record<CapabilityId, string>> = {
  central: 'Central agent', workers: 'Worker orchestrator', autonomy: 'Central agent autonomy', browser: 'Browser on canvas',
  files: 'Files', filesWrite: 'Edit and upload files', telegram: 'Telegram',
}
const SUB_NAME: Readonly<Record<string, string>> = {
  WEBTERM_RUN_REQUIRE_APPROVAL: 'Ask before a worker runs',
  WEBTERM_BROWSER_AGENT: 'Let agents control the browser',
}

/** Keys that have a direct UI control, mapped to where it lives. */
export const UI_SWITCHES: ReadonlyMap<string, string> = new Map<string, string>([
  ...CAPABILITY_IDS.map((id): [string, string] => [CAPABILITIES[id].primaryKey, `${CAP} › ${CAPABILITY_NAME[id]}`]),
  ...CAPABILITY_IDS.flatMap((id) => (CAPABILITIES[id].subs ?? []).map((s): [string, string] =>
    [s.key, `${CAP} › ${CAPABILITY_NAME[id]} › ${SUB_NAME[s.key] ?? s.key}`])),
  [CENTRAL_RUNTIME_FLAG, `${CAP} › Advanced › Agent engine`],
  [ENV_BROWSER.bin, `${CAP} › Advanced › Chrome location`],
  ['WEBTERM_TELEGRAM_BOT_TOKEN', `${CAP} › Telegram › Connect bot`],
  [ENV_BROWSER.allowHosts, 'Browser node › blocked-address notice › Allow host'],
])

/** Keys written by capability cards (never set directly): key -> capabilities it follows, in priority order. */
export const DERIVED_FROM: ReadonlyMap<string, readonly CapabilityId[]> = (() => {
  const m = new Map<string, CapabilityId[]>()
  for (const d of [...DERIVED_FLAGS, ...LINKED_SETTINGS]) {
    const list = m.get(d.key) ?? []
    for (const n of d.needs) if (!list.includes(n)) list.push(n)
    m.set(d.key, list)
  }
  return m
})()

/** UI location for a derived key: the card(s) it follows. */
export const derivedWhere = (ids: readonly CapabilityId[]): string => `${CAP} › ${ids.map((i) => CAPABILITY_NAME[i]).join(' / ')} (derived)`

/**
 * Behaviour keys that still have NO UI control. Allowed for F0 only; F1-f (`wkr-ctl-06`) turns each into a
 * live switch and removes it here. The drift test fails if a key is missing from both this list and the UI
 * maps, or if a key listed here gains a UI control (stale entry).
 */
export const ENV_ONLY_PENDING_F1: readonly string[] = [
  'WEBTERM_LEDGER', 'WEBTERM_TELEGRAM_MODE', 'WEBTERM_TELEGRAM_WEBHOOK_SECRET', 'WEBTERM_TRUST_PROXY',
  'WEBTERM_CENTRAL_MODEL', 'WEBTERM_OPENCODE_BIN', 'WEBTERM_OPENCODE_ALLOW_TOOLS', 'WEBTERM_CENTRAL_CHECKPOINT',
  'WEBTERM_CENTRAL_MAX_STEPS', 'WEBTERM_CENTRAL_TURN_WALL_MS', 'WEBTERM_CENTRAL_TURN_TOKENS', 'WEBTERM_CENTRAL_TURN_STEPS',
  'WEBTERM_CENTRAL_DAILY_TOKENS', 'WEBTERM_CENTRAL_DAILY_SPAWNS', 'WEBTERM_CENTRAL_DAILY_COST_MICROS',
  'WEBTERM_CENTRAL_SKILLS', 'WEBTERM_CENTRAL_SKILL_PROPOSE', 'WEBTERM_CENTRAL_BOTS', 'WEBTERM_CHANNEL_APPROVAL_BUTTONS',
  'WEBTERM_KNOWLEDGE', 'WEBTERM_AGENT_IDLE_DONE_MS', 'WEBTERM_CENTRAL_RELIABILITY', 'WEBTERM_CENTRAL_MAX_INFLIGHT',
  'WEBTERM_AGENT_MAIL', 'WEBTERM_CENTRAL_CONTEXT_WINDOW', 'WEBTERM_MEMORY_FILES', 'WEBTERM_MEMORY_DIR',
  'WEBTERM_CONTROL_CWD_ROOTS', 'WEBTERM_LOG_LEVEL', 'WEBTERM_LOG_BUFFER', 'WEBTERM_LOG_FILE',
  'WEBTERM_BROWSER_MAX_LIVE', 'WEBTERM_BROWSER_DISCARD_MS', 'WEBTERM_BROWSER_COOKIE_IMPORT', 'WEBTERM_BROWSER_COOKIE_TTL_DAYS',
  'WEBTERM_BROWSER_HEADLESS', 'WEBTERM_FILES_LIST_MAX', 'WEBTERM_FILES_UPLOAD_MAX_MB',
]

/** UI location for a registry key, or null when it is env-only. */
export function uiWhere(key: string): string | null {
  const direct = UI_SWITCHES.get(key)
  if (direct) return direct
  const derived = DERIVED_FROM.get(key)
  return derived ? derivedWhere(derived) : null
}
