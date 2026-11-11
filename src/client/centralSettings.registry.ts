// Settings › Central Agent as data: one entry per control. Adding a Central setting = one entry here
// + its text in `centralSettingsLabels.ts`; `CentralSettingsSection.tsx` renders whatever is listed.
// Capability sub keys are the wire keys (`subKeyOf` in featureCapabilities.service.ts), not env names.
import { CHECKIN_DAILY_LIMITS } from '../shared/centralWork'
import type { CapabilityId } from '../shared/featureCapabilities'
import type { Settings } from '../shared/settings'
import { PROJECT_MODEL_ALIASES } from '../shared/settings.projectModels'
import { CENTRAL_FIELD_TEXT, CENTRAL_TEXT, LEVEL_TEXT, MODEL_TEXT, UNIT_TEXT, tokensLabel } from './centralSettingsLabels'
import { COST_CAP_KEY } from './SettingsCostLimit'
import type { SettingsFieldId } from './settings.link'

export const CENTRAL_GROUPS = ['status', 'autonomy', 'cost', 'abilities', 'telegram', 'advanced'] as const
export type CentralGroup = (typeof CENTRAL_GROUPS)[number]
export type CentralControl = 'switch' | 'segmented' | 'stepper' | 'select' | 'combobox' | 'link' | 'status'
/** Where a link lands: a Settings section id, plus the setting revealed in it (`data-field`, ./settings.link). */
export interface CentralLinkTarget { section: string; field: SettingsFieldId }
export type CentralSource =
  | { kind: 'capability'; id: CapabilityId; sub?: string }
  /** `scale` = stored value per shown unit (ms per second). */
  | { kind: 'env'; key: string; unit?: string; scale?: number }
  | { kind: 'setting'; key: keyof Settings }
  | { kind: 'link'; to: CentralLinkTarget }
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
  /** Listed under "Experiments" inside Advanced. */
  experiment?: boolean
  /** Works while Central is off (only the master switch and navigation). */
  always?: boolean
  /** Disabled unless this capability is on (besides Central). */
  needs?: CapabilityId
}

const tokens = (ns: readonly number[]): CentralOption[] => ns.map((n) => ({ value: String(n), label: tokensLabel(n) }))
const f = (id: CentralField['id'], rest: Omit<CentralField, 'id' | 'label' | 'hint'>): CentralField => ({ id, ...CENTRAL_FIELD_TEXT[id], ...rest })
const link = (section: string, field: SettingsFieldId): CentralSource => ({ kind: 'link', to: { section, field } })
const env = (key: string, extra: { unit?: string; scale?: number } = {}): CentralSource => ({ kind: 'env', key, ...extra })

export const CENTRAL_FIELDS: readonly CentralField[] = [
  f('central', { group: 'status', control: 'switch', source: { kind: 'capability', id: 'central' }, always: true }),
  f('engine', { group: 'status', control: 'status', source: { kind: 'capability', id: 'central' }, always: true }),
  f('profile', { group: 'status', control: 'select', source: { kind: 'setting', key: 'centralClaudeProfileId' } }),
  f('profiles', { group: 'status', control: 'link', source: link('agent', 'claudeLaunchProfiles'), always: true }),

  f('level', {
    group: 'autonomy', control: 'segmented', source: { kind: 'capability', id: 'autonomy' },
    options: [
      { value: 'none', label: LEVEL_TEXT.none },
      { value: 'workers', label: LEVEL_TEXT.workers },
      { value: 'autonomy', label: LEVEL_TEXT.autonomy, confirm: CENTRAL_TEXT.confirmAutonomy },
    ],
  }),
  f('askEachWorker', { group: 'autonomy', control: 'switch', source: { kind: 'capability', id: 'workers', sub: 'runRequireApproval' }, needs: 'workers' }),
  f('dailySpawns', { group: 'autonomy', control: 'stepper', source: env('WEBTERM_CENTRAL_DAILY_SPAWNS', { unit: UNIT_TEXT.workers }), min: 0, max: 500, step: 5, needs: 'workers' }),
  f('checkin', { group: 'autonomy', control: 'switch', source: { kind: 'checkin', key: 'enabled' } }),
  f('checkinLimit', { group: 'autonomy', control: 'select', source: { kind: 'checkin', key: 'dailyLimit' }, options: CHECKIN_DAILY_LIMITS.map((n) => ({ value: String(n), label: String(n) })) }),

  f('costLimit', { group: 'cost', control: 'combobox', source: env(COST_CAP_KEY, { unit: '$' }) }),
  f('ladder', { group: 'cost', control: 'link', source: link('agent', 'model-ladder'), always: true }),

  f('skills', { group: 'abilities', control: 'switch', source: { kind: 'capability', id: 'central', sub: 'centralSkills' } }),
  f('skillPropose', { group: 'abilities', control: 'switch', source: { kind: 'capability', id: 'central', sub: 'centralSkillPropose' } }),
  f('checkpoint', { group: 'abilities', control: 'switch', source: { kind: 'capability', id: 'central', sub: 'centralCheckpoint' } }),
  f('browser', { group: 'abilities', control: 'status', source: { kind: 'capability', id: 'browser', sub: 'browserAgent' }, always: true }),

  f('telegram', { group: 'telegram', control: 'status', source: { kind: 'capability', id: 'telegram' }, always: true }),

  f('model', {
    group: 'advanced', control: 'select', source: env('WEBTERM_CENTRAL_MODEL'),
    options: [{ value: '', label: MODEL_TEXT.auto }, ...PROJECT_MODEL_ALIASES.map((m) => ({ value: m, label: MODEL_TEXT[m] }))],
  }),
  f('turnSeconds', { group: 'advanced', control: 'stepper', source: env('WEBTERM_CENTRAL_TURN_WALL_MS', { unit: UNIT_TEXT.seconds, scale: 1000 }), min: 10, max: 600, step: 10 }),
  f('turnSteps', { group: 'advanced', control: 'stepper', source: env('WEBTERM_CENTRAL_TURN_STEPS', { unit: UNIT_TEXT.steps }), min: 1, max: 100, step: 1 }),
  f('contextWindow', { group: 'advanced', control: 'select', source: env('WEBTERM_CENTRAL_CONTEXT_WINDOW'), options: tokens([128_000, 200_000, 1_000_000]) }),
  f('dailyTokens', { group: 'advanced', control: 'select', source: env('WEBTERM_CENTRAL_DAILY_TOKENS'), options: tokens([1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 0]) }),
  f('maxInflight', { group: 'advanced', control: 'stepper', source: env('WEBTERM_CENTRAL_MAX_INFLIGHT', { unit: UNIT_TEXT.workers }), min: 1, max: 20, step: 1, needs: 'autonomy' }),
  f('knowledge', { group: 'advanced', control: 'switch', source: env('WEBTERM_KNOWLEDGE'), experiment: true }),
  f('reliability', { group: 'advanced', control: 'switch', source: env('WEBTERM_CENTRAL_RELIABILITY'), experiment: true, needs: 'autonomy' }),
  f('mail', { group: 'advanced', control: 'switch', source: env('WEBTERM_AGENT_MAIL'), experiment: true, needs: 'workers' }),
]

/** Env keys the section reads and writes (one GET of /api/settings/env serves them all). */
export const CENTRAL_ENV_KEYS: readonly string[] = CENTRAL_FIELDS.flatMap((x) => (x.source.kind === 'env' ? [x.source.key] : []))
