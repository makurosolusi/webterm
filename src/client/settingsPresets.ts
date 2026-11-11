// Preset lists for Settings pickers (selects and combobox suggestions). Every value stays inside the
// key's `SETTING_RANGES` bounds; `settingsPresets.test.ts` pins that.
import { DEFAULT_SETTINGS } from '../shared/settings'
import type { ComboPreset } from './SettingsCombobox'

const KIB = 1024
const MIB = 1024 * KIB

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

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black',
}
export const FONT_WEIGHT_OPTIONS = Object.entries(WEIGHT_NAMES).map(([w, name]) => ({ value: Number(w), label: `${w} · ${name}` }))

export const SCROLLBACK_PRESETS: readonly ComboPreset[] = [1_000, 5_000, 10_000, 50_000].map((n) => ({
  value: String(n),
  label: `${n.toLocaleString('en-US')} lines${n === DEFAULT_SETTINGS.scrollbackLines ? ' (default)' : ''}`,
}))

export const REPLAY_BUFFER_OPTIONS = [64 * KIB, 256 * KIB, MIB, 4 * MIB, 16 * MIB, 64 * MIB].map((n) => ({
  value: n,
  label: `${n >= MIB ? `${n / MIB} MiB` : `${n / KIB} KiB`}${n === DEFAULT_SETTINGS.scrollbackBytes ? ' (default)' : ''}`,
}))

/** Word separators always contain a space (stored history is trimmed, so a picked value gets it back). */
export const withSpace = (v: string): string => (v.includes(' ') ? v : ` ${v}`)

export const WORD_SEPARATOR_PRESETS: readonly ComboPreset[] = [
  { value: DEFAULT_SETTINGS.terminalWordSeparator, label: 'Default (paths and identifiers stay whole)' },
  { value: ' ', label: 'Spaces only' },
  { value: `${DEFAULT_SETTINGS.terminalWordSeparator}/.:-_`, label: 'Also split at / . : - _' },
]

// ponytail: fixed list; a server endpoint reading /etc/shells would show only installed shells.
export const SHELL_PRESETS: readonly ComboPreset[] = [
  { value: '', label: 'System default shell' },
  { value: '/bin/zsh' },
  { value: '/bin/bash' },
  { value: '/bin/sh' },
]

export const GRID_SIZE_OPTIONS = [8, 12, 16, 20, 24, 32, 40, 48].map((n) => ({ value: n, label: `${n} px` }))
export const NODE_WIDTH_OPTIONS = [400, 480, 560, 640, 800, 960, 1200, 1600].map((n) => ({ value: n, label: `${n} px` }))
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
export const NODE_HEIGHT_OPTIONS = [280, 360, 440, 520, 600, 720, 900, 1200].map((n) => ({ value: n, label: `${n} px` }))

/** Cost cap suggestions in dollars; '' = no limit. The field id is Central's daily limit (Settings › Central), the one daily limit for all work. */
export const COST_CAP_FIELD_ID = 'central.dailyCostCap'
export const COST_CAP_PRESETS: readonly ComboPreset[] = [
  { value: '', label: 'No limit' },
  { value: '5', label: '$5' },
  { value: '10', label: '$10' },
  { value: '25', label: '$25' },
  { value: '50', label: '$50' },
]
