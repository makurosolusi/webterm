// Where each env registry key is controlled from the UI (read model for the Control panel, F0-c).
// Pure data over the capability catalog; the A2 drift test checks every registry key against this
// map; any other key is edited in the Control tab, and the A2 test renders a control for each of them.
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

/** Every behaviour key without a dedicated card or notice is edited directly in the Control tab (F1-f). */
export const CONTROL_WHERE = 'Settings › Control'

/** UI location for a registry key: its card or notice, the card it is derived from, else the Control tab. */
export function uiWhere(key: string): string {
  const direct = UI_SWITCHES.get(key)
  if (direct) return direct
  const derived = DERIVED_FROM.get(key)
  return derived ? derivedWhere(derived) : CONTROL_WHERE
}
