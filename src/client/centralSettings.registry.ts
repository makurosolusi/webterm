// Settings › Central Agent as data: one entry per control. Adding a Central setting = one entry here
// + its text in `centralSettingsLabels.ts`; `CentralSettingsSection.tsx` renders whatever is listed.
// Capability sub keys are the wire keys (`subKeyOf` in featureCapabilities.service.ts), not env names.
import { CHECKIN_DAILY_LIMITS } from '../shared/centralWork'
import type { CapabilityId } from '../shared/featureCapabilities'
import { CENTRAL_FIELD_TEXT, CENTRAL_TEXT, LEVEL_TEXT, UNIT_TEXT } from './centralSettingsLabels'
import { COST_CAP_KEY } from './SettingsCostLimit'
import type { SettingsFieldId } from './settings.link'

export const CENTRAL_GROUPS = ['status', 'autonomy', 'cost', 'advanced'] as const
export type CentralGroup = (typeof CENTRAL_GROUPS)[number]
export type CentralControl = 'switch' | 'segmented' | 'stepper' | 'select' | 'combobox'
/** Where a link lands: a Settings section id, plus the setting revealed in it (`data-field`, ./settings.link). */
export interface CentralLinkTarget { section: string; field: SettingsFieldId }
export type CentralSource =
  | { kind: 'capability'; id: CapabilityId; sub?: string }
  /** `scale` = stored value per shown unit (ms per second). */
  | { kind: 'env'; key: string; unit?: string; scale?: number }
  | { kind: 'checkin'; key: 'enabled' | 'dailyLimit' }

export interface CentralOption { value: string; label: string; confirm?: string }
export interface CentralField {
  id: keyof typeof CENTRAL_FIELD_TEXT
  group: CentralGroup
  label: string
  hint: string
  control: CentralControl
  source: CentralSource
  /** select/segmented choices; for `segmented` over capabilities each value is a capability id ('none' = all off). */
  options?: readonly CentralOption[]
  min?: number
  max?: number
  step?: number
  /** Works while Central is off (only the master switch and navigation). */
  always?: boolean
  /** Disabled unless this capability is on (besides Central). */
  needs?: CapabilityId
}

const f = (id: CentralField['id'], rest: Omit<CentralField, 'id' | 'label' | 'hint'>): CentralField => ({ id, ...CENTRAL_FIELD_TEXT[id], ...rest })
const env = (key: string, extra: { unit?: string; scale?: number } = {}): CentralSource => ({ kind: 'env', key, ...extra })

// Only real preferences are listed. Automatic now (no row): the model (ladder), context window (from the model,
// rotationPolicy.ts), reply time and steps (scaled to the model tier, turnLimits.ts), the token budget (the dollar
// limit is the budget), skills and checkpoints (always on), project knowledge / steadier autonomy / agent mail (on
// with "Work on its own", LINKED_SETTINGS). "Propose work" always asks before a worker runs (the switch merged into it).
export const CENTRAL_FIELDS: readonly CentralField[] = [
  f('central', { group: 'status', control: 'switch', source: { kind: 'capability', id: 'central' }, always: true }),

  f('level', {
    group: 'autonomy', control: 'segmented', source: { kind: 'capability', id: 'autonomy' },
    options: [
      { value: 'none', label: LEVEL_TEXT.none },
      { value: 'workers', label: LEVEL_TEXT.workers },
      { value: 'autonomy', label: LEVEL_TEXT.autonomy, confirm: CENTRAL_TEXT.confirmAutonomy },
    ],
  }),
  f('checkin', { group: 'autonomy', control: 'switch', source: { kind: 'checkin', key: 'enabled' } }),

  f('costLimit', { group: 'cost', control: 'combobox', source: env(COST_CAP_KEY, { unit: '$' }) }),

  f('dailySpawns', { group: 'advanced', control: 'stepper', source: env('WEBTERM_CENTRAL_DAILY_SPAWNS', { unit: UNIT_TEXT.workers }), min: 0, max: 500, step: 5, needs: 'workers' }),
  f('checkinLimit', { group: 'advanced', control: 'select', source: { kind: 'checkin', key: 'dailyLimit' }, options: CHECKIN_DAILY_LIMITS.map((n) => ({ value: String(n), label: String(n) })) }),
  f('maxInflight', { group: 'advanced', control: 'stepper', source: env('WEBTERM_CENTRAL_MAX_INFLIGHT', { unit: UNIT_TEXT.workers }), min: 1, max: 20, step: 1, needs: 'autonomy' }),
]

/** Env keys the section reads and writes (one GET of /api/settings/env serves them all). */
export const CENTRAL_ENV_KEYS: readonly string[] = CENTRAL_FIELDS.flatMap((x) => (x.source.kind === 'env' ? [x.source.key] : []))
