// Links into Settings that name the exact setting, like VS Code's "reveal setting": a section plus a
// field id. The URL carries both (`?settings=<section>&field=<id>`, ./appRoute) and the panel scrolls to,
// focuses and flashes the element `[data-field="<id>"]` (SettingsPanel). React-free: the start-up
// chunk (appRoute's whitelist) imports it.
import { CAPABILITY_IDS, type CapabilityId } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { CENTRAL_FIELD_TEXT } from './centralSettingsLabels'

/** Rows of Settings › Central Agent (`centralSettings.registry.ts` ids). */
export type CentralFieldId = keyof typeof CENTRAL_FIELD_TEXT
/** Blocks without a Settings key of their own. */
const BLOCK_FIELD_IDS = ['model-ladder', 'claude-provider', 'chromium', 'agentEngine'] as const

/**
 * What `data-field` may hold, and so what a link may target: a `Field setting="<key>"` (its key),
 * a Central row (`central.<id>`), a capability card (`capability.<id>`) or one of the blocks above.
 */
export type SettingsFieldId = keyof Settings | `central.${CentralFieldId}` | `capability.${CapabilityId}` | (typeof BLOCK_FIELD_IDS)[number]

const FIELD_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_SETTINGS),
  ...Object.keys(CENTRAL_FIELD_TEXT).map((id) => `central.${id}`),
  ...CAPABILITY_IDS.map((id) => `capability.${id}`),
  ...BLOCK_FIELD_IDS,
])

/** The id when a link may target it, else null (unknown ids from a URL are dropped). */
export function toSettingsFieldId(id: string | null | undefined): SettingsFieldId | null {
  return typeof id === 'string' && FIELD_IDS.has(id) ? (id as SettingsFieldId) : null
}

/** Event that opens Settings (App's SettingsHost listens): `detail.section` = section id (legacy and
 *  scoped ids such as `background:workspace` allowed), `detail.field` = the setting to reveal. */
export const OPEN_SETTINGS_EVENT = 'webterm:open-settings'

/** Open Settings on `section` and reveal `field` in it. Works from React and non-React code alike. */
export function openSettingsAt(section: string, field: SettingsFieldId): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section, field } }))
}

/** Open a whole section (no single setting is the target: the ⌘, command, Account, Rules…). */
export function openSettingsSection(section: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section } }))
}
