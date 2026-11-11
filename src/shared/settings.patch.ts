// Settings patch semantics, shared by the server store and the client state so both apply a PATCH
// the same way. Most keys replace wholesale. Map-valued keys edited one entry at a time (a
// workspace's wallpaper) are ENTRY keys: a patch carries only the entries it changes and `null`
// deletes one, so a tab holding a stale copy of the map cannot wipe entries other tabs wrote.
// Reference: VS Code `ConfigurationEditing` writes one JSON path at a time, never the whole file.
import type { Settings } from './settings'
import { applySetupPatch, mergeSetupPatches, type SetupPatch } from './settings.setup'

/** Map-valued keys patched per entry. `keybindings` is NOT one: `null` there means "unbind". */
export const ENTRY_PATCH_KEYS = ['canvasBackgroundByWorkspace', 'projectModels', 'inputHistory'] as const
type EntryKey = (typeof ENTRY_PATCH_KEYS)[number]

/** A settings PATCH: entry keys carry changed entries only, `null` = delete that entry; `setup`
 *  merges field by field and `setup.steps` per step (`settings.setup.ts`). */
export type SettingsPatch = Omit<Partial<Settings>, EntryKey | 'setup'> & {
  [K in EntryKey]?: Record<string, Settings[K][string] | null>
} & { setup?: SetupPatch }

export const isEntryKey = (k: string): k is EntryKey => (ENTRY_PATCH_KEYS as readonly string[]).includes(k)

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** `patch` written onto `doc` (a Settings view or the raw stored document); returns a new object. */
export function applySettingsPatch<T extends object>(doc: T, patch: object): T {
  const out = { ...doc } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === 'setup') { out[k] = applySetupPatch(out[k], v); continue }
    if (!isEntryKey(k)) { out[k] = v; continue }
    const map = { ...rec(out[k]) }
    for (const [id, entry] of Object.entries(rec(v))) {
      if (entry === null) delete map[id]
      else map[id] = entry
    }
    out[k] = map
  }
  return out as T
}

/** Two pending patches as one (`b` wins): entry keys keep both sides' entries, deletions included. */
export function mergeSettingsPatches(a: SettingsPatch, b: SettingsPatch): SettingsPatch {
  const out: Record<string, unknown> = { ...a, ...b }
  for (const k of ENTRY_PATCH_KEYS) {
    if (a[k] && b[k]) out[k] = { ...a[k], ...b[k] }
  }
  if (a.setup && b.setup) out.setup = mergeSetupPatches(a.setup, b.setup)
  return out as SettingsPatch
}

/** What `patch[key]` replaces in `current`, as a patch value (entry keys: per entry, absent = null). */
export function settingsPatchBefore(current: Settings, key: keyof Settings, value: unknown): unknown {
  if (key === 'setup') {
    const steps = current.setup.steps as Record<string, unknown>
    const before: Record<string, unknown> = { steps: Object.fromEntries(Object.keys(rec(rec(value).steps)).map((id) => [id, steps[id] ?? null])) }
    if ('completedAt' in rec(value)) before.completedAt = current.setup.completedAt
    return before
  }
  if (!isEntryKey(key)) return current[key]
  const map = current[key]
  return Object.fromEntries(Object.keys(rec(value)).map((id) => [id, map[id] ?? null]))
}
