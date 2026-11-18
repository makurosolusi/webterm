// Links into Settings that name the exact setting, like VS Code's "reveal setting": a section plus a
// field id. The URL carries both (`?settings=<section>&field=<id>`, ./appRoute) and the panel scrolls to,
// focuses and flashes the element `[data-field="<id>"]` (SettingsPanel). React-free: the start-up
// chunk (appRoute's whitelist) imports it.
import { CAPABILITY_IDS, type CapabilityId } from '../shared/featureCapabilities'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { CENTRAL_FIELD_TEXT } from './centralSettingsLabels'
import type { SectionId } from './settingsSections.registry'

/** Rows of Settings › Central Agent (`centralSettings.registry.ts` ids). */
export type CentralFieldId = keyof typeof CENTRAL_FIELD_TEXT
/** Blocks without a Settings key of their own. */
const BLOCK_FIELD_IDS = ['model-ladder', 'claude-provider', 'chromium', 'agentEngine', 'browser-profiles', 'browser-limit', 'header-mode'] as const

/**
 * What `data-field` may hold, and so what a link may target: a `Field setting="<key>"` (its key),
 * a Central row (`central.<id>`), a capability card (`capability.<id>`), a Keyboard Shortcuts row
 * (`keybinding.<command id>`) or one of the blocks above.
 */
export type SettingsFieldId = keyof Settings | `central.${CentralFieldId}` | `capability.${CapabilityId}` | `keybinding.${string}` | (typeof BLOCK_FIELD_IDS)[number]

/** The Keyboard Shortcuts row of command `id`. */
export const keybindingFieldId = (id: string): `keybinding.${string}` => `keybinding.${id}`
/** Command ids are registered at run time, so any well-formed one may be targeted (an unknown one reveals nothing). */
const KEYBINDING_FIELD = /^keybinding\.[\w.-]+$/

const FIELD_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_SETTINGS),
  ...Object.keys(CENTRAL_FIELD_TEXT).map((id) => `central.${id}`),
  ...CAPABILITY_IDS.map((id) => `capability.${id}`),
  ...BLOCK_FIELD_IDS,
])

/** A setting that moved page (Settings overhaul): an old link `?settings=<old>&field=<old id>` lands here. */
export interface MovedField { section: SectionId; field: SettingsFieldId }
const toClaude = (field: SettingsFieldId): MovedField => ({ section: 'claude', field })
const toCentral: MovedField = { section: 'central', field: 'central.central' }
/** Retired field ids -> where that setting lives now (Central rows that became automatic land on Central itself). */
const MOVED_FIELDS: Readonly<Record<string, MovedField>> = {
  skipApprovals: toClaude('agentApprovalLevel'),
  hookReplyApprovals: toClaude('agentApprovalLevel'),
  defaultClaudeProfileId: toClaude('claude-provider'),
  projectModels: toClaude('model-ladder'),
  claudePermissionMode: toClaude('claudePermissionMode'),
  disabledAgents: toClaude('disabledAgents'),
  customAgents: toClaude('customAgents'),
  claudeLaunchProfiles: toClaude('claudeLaunchProfiles'),
  'model-ladder': toClaude('model-ladder'),
  'claude-provider': toClaude('claude-provider'),
  'central.profile': toClaude('centralClaudeProfileId'),
  'central.profiles': toClaude('claudeLaunchProfiles'),
  'central.ladder': toClaude('model-ladder'),
  'central.askEachWorker': { section: 'central', field: 'central.level' },
  ...Object.fromEntries(['engine', 'report', 'skills', 'skillPropose', 'checkpoint', 'browser', 'telegram', 'model', 'turnSeconds', 'turnSteps',
    'contextWindow', 'dailyTokens', 'knowledge', 'reliability', 'mail'].map((id) => [`central.${id}`, toCentral])),
}

/** Where a retired or moved field id lives now, else null. */
export function movedSettingsField(id: string | null | undefined): MovedField | null {
  return typeof id === 'string' ? MOVED_FIELDS[id] ?? null : null
}

/** The id when a link may target it (a moved id becomes its new one), else null (unknown ids from a URL are dropped). */
export function toSettingsFieldId(id: string | null | undefined): SettingsFieldId | null {
  const moved = movedSettingsField(id)
  if (moved) return moved.field
  return typeof id === 'string' && (FIELD_IDS.has(id) || KEYBINDING_FIELD.test(id)) ? (id as SettingsFieldId) : null
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
