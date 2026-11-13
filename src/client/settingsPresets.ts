// Preset lists for Settings pickers (selects and combobox suggestions). Every value stays inside the
// key's `SETTING_RANGES` bounds; `settingsPresets.test.ts` pins that.
import { DEFAULT_SETTINGS } from '../shared/settings'
import { SETTING_RANGES } from '../shared/settings.ranges'
import { firstFamily, isFontInstalled, renderedFamily } from './fontDetect'
import type { ComboPreset } from './SettingsCombobox'

export const FONT_FAMILY_PRESETS: readonly ComboPreset[] = [
  { value: DEFAULT_SETTINGS.fontFamily, label: 'Menlo (default)' },
  { value: '"SF Mono", Menlo, monospace', label: 'SF Mono' },
  { value: '"JetBrains Mono", monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", monospace', label: 'Fira Code' },
  { value: '"Cascadia Code", monospace', label: 'Cascadia Code' },
  { value: '"Source Code Pro", monospace', label: 'Source Code Pro' },
  { value: '"IBM Plex Mono", monospace', label: 'IBM Plex Mono' },
  { value: 'Consolas, monospace', label: 'Consolas' },
  { value: '"DejaVu Sans Mono", monospace', label: 'DejaVu Sans Mono' },
  { value: 'monospace', label: 'System monospace' },
]

/**
 * Font presets installed on this computer: the default first, named after the font it really renders
 * ("Menlo (default)" on macOS, the fallback elsewhere), then each other preset whose font is present.
 */
export function installedFontPresets(): ComboPreset[] {
  const [, ...others] = FONT_FAMILY_PRESETS
  return [
    { value: DEFAULT_SETTINGS.fontFamily, label: `${renderedFamily(DEFAULT_SETTINGS.fontFamily)} (default)` },
    ...others.filter((p) => isFontInstalled(firstFamily(p.value))),
  ]
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black',
}
export const FONT_WEIGHT_OPTIONS = Object.entries(WEIGHT_NAMES).map(([w, name]) => ({ value: Number(w), label: `${name} (${w})` }))

/** History length as people read it: "25,000 lines" (also the at-rest text of a custom value). */
export const formatLines = (v: string): string => (Number.isFinite(Number(v)) && v.trim() ? `${Number(v).toLocaleString('en-US')} lines` : v)

export const SCROLLBACK_PRESETS: readonly ComboPreset[] = [1_000, 5_000, 10_000, 50_000].map((n) => ({
  value: String(n),
  label: `${formatLines(String(n))}${n === DEFAULT_SETTINGS.scrollbackLines ? ' (default)' : ''}`,
}))

/**
 * Server replay buffer for a terminal history length: History length is ONE control for both buffers.
 * Proportional to the defaults (10,000 lines <-> 256 KiB), so the default stays exactly the default.
 */
export function replayBytesFor(lines: number): number {
  const { min, max, step } = SETTING_RANGES.scrollbackBytes
  const bytes = Math.ceil((lines * DEFAULT_SETTINGS.scrollbackBytes) / DEFAULT_SETTINGS.scrollbackLines / step) * step
  return Math.min(max, Math.max(min, bytes))
}

/** Word separators always contain a space (stored history is trimmed, so a picked value gets it back). */
export const withSpace = (v: string): string => (v.includes(' ') ? v : ` ${v}`)

export const WORD_SEPARATOR_PRESETS: readonly ComboPreset[] = [
  { value: DEFAULT_SETTINGS.terminalWordSeparator, label: 'Default (paths and identifiers stay whole)' },
  { value: ' ', label: 'Spaces only' },
  { value: `${DEFAULT_SETTINGS.terminalWordSeparator}/.:-_`, label: 'Also split at / . : - _' },
]

/** Default shell choices: the system default, then the shells this machine has (GET /api/settings/shells). */
export const shellPresets = (installed: readonly string[]): ComboPreset[] => [
  { value: '', label: 'System default shell' },
  ...installed.map((value) => ({ value })),
]

export const GRID_SIZE_OPTIONS = [8, 12, 16, 20, 24, 32, 40, 48].map((n) => ({ value: n, label: `${n} px` }))
export const EDGE_WIDTH_OPTIONS = [1, 1.5, 2, 3, 4].map((n) => ({
  value: n, label: `${n} px${n === DEFAULT_SETTINGS.edgeWidth ? ' (default)' : ''}`,
}))
/** Mid-tone cable colors that stay visible on both light and dark canvases. */
export const EDGE_COLOR_PRESETS: readonly { label: string; color: string }[] = [
  { label: 'Blue', color: '#3b82f6' },
  { label: 'Teal', color: '#14b8a6' },
  { label: 'Green', color: '#22c55e' },
  { label: 'Amber', color: '#f59e0b' },
  { label: 'Orange', color: '#f97316' },
  { label: 'Red', color: '#ef4444' },
  { label: 'Pink', color: '#ec4899' },
  { label: 'Purple', color: '#8b5cf6' },
]

/** Cost cap suggestions in dollars; '' = no limit. The field id is Central's daily limit (Settings › Central), the one daily limit for all work. */
export const COST_CAP_FIELD_ID = 'central.dailyCostCap'
export const COST_CAP_PRESETS: readonly ComboPreset[] = [
  { value: '', label: 'No limit' },
  { value: '5', label: '$5' },
  { value: '10', label: '$10' },
  { value: '25', label: '$25' },
  { value: '50', label: '$50' },
]
