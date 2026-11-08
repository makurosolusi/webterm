// Plain-word choices for the Routines form: schedule presets (cron underneath) and the small number
// pickers under "More options". Custom cron stays possible; `cronError` is the server's own parser.
import type { ComboPreset } from './SettingsCombobox'

export const ROUTINE_SCHEDULE_FIELD_ID = 'routines.schedule'
export const ROUTINE_SCHEDULE_PRESETS: readonly ComboPreset[] = [
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 9 * * *', label: 'Every day at 9:00' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9:00' },
  { value: '0 9 * * 1', label: 'Every Monday at 9:00' },
]

/** "Every hour" for a preset cron, else the cron itself in plain framing. */
export const scheduleText = (cron: string): string =>
  ROUTINE_SCHEDULE_PRESETS.find((p) => p.value === cron.trim())?.label ?? `Custom schedule (${cron})`

export const ROUTINE_MAX_COST_FIELD_ID = 'routines.maxCostPerDay'
export const ROUTINE_MAX_COST_PRESETS: readonly ComboPreset[] = [
  { value: '', label: 'No limit' },
  { value: '1', label: '$1' },
  { value: '2', label: '$2' },
  { value: '5', label: '$5' },
  { value: '10', label: '$10' },
]

export const MAX_RUNS_CHOICES = [1, 2, 4, 12, 24, 48, 96] as const
export const TIMEOUT_CHOICES = [10, 30, 60, 120, 300, 600] as const
export const DEBOUNCE_CHOICES = [0, 1, 5, 15, 30, 60] as const

/** Select options for `choices`, plus `current` when a stored value is not one of them (it must stay visible). */
export const numberOptions = (choices: readonly number[], current: number, unit: (n: number) => string): { value: string; label: string }[] =>
  [...new Set([...choices, current])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: unit(n) }))
