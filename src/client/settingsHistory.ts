// Undo/redo for Settings changes (F3-d, acceptance A6). Pure and DOM-free so it is testable in
// node-env; `useSettings` owns one instance and `SettingsPanel` drives it (toast + ⌘Z/⇧⌘Z).
//
// Each entry stores the BEFORE and AFTER values of only the keys a patch touched, so undo is a
// patch too and goes through the same coalesced PUT as any edit. Covered: every key of `Settings`
// (`/api/settings`). Not covered by design: env-registry rows of Settings › Developer
// (`/api/settings/env`), which have their own store and can be env-locked (shell env wins), so an
// undo there could not be applied anyway.
//
// Coalescing mirrors VS Code's text undo grouping: repeated edits to the same key set inside a
// short window (a slider drag, typing in a number box) collapse into one step.
import type { Settings } from '../shared/settings'
import { mergeSettingsPatches, settingsPatchBefore, type SettingsPatch } from '../shared/settings.patch'

/** How many changes can be undone. */
export const SETTINGS_HISTORY_CAP = 20
/** Edits to the same keys closer together than this are one undo step. */
export const SETTINGS_COALESCE_MS = 1000

export interface SettingsChange {
  keys: (keyof Settings)[]
  before: SettingsPatch
  after: SettingsPatch
  at: number
}

export interface SettingsHistory {
  /** Record `patch` applied on top of `current` (the state BEFORE the patch). No-op patches are dropped. */
  record(current: Settings, patch: SettingsPatch): SettingsChange | undefined
  /** The step to revert, or undefined. Apply `change.before` without recording it. */
  undo(): SettingsChange | undefined
  /** The step to re-apply, or undefined. Apply `change.after` without recording it. */
  redo(): SettingsChange | undefined
  canUndo(): boolean
  canRedo(): boolean
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k) => b.includes(k))

export function createSettingsHistory(opts: { cap?: number; coalesceMs?: number; now?: () => number } = {}): SettingsHistory {
  const cap = opts.cap ?? SETTINGS_HISTORY_CAP
  const coalesceMs = opts.coalesceMs ?? SETTINGS_COALESCE_MS
  const now = opts.now ?? Date.now
  const items: SettingsChange[] = []
  let done = 0 // items[0..done) are applied; items[done..] are redoable

  return {
    record(current, patch) {
      // Entry keys (settings.patch.ts) record per-entry before values, absent = null, so an undo deletes what the step added.
      const value = (k: keyof Settings): unknown => (patch as Record<string, unknown>)[k]
      const keys = (Object.keys(patch) as (keyof Settings)[]).filter((k) => !same(settingsPatchBefore(current, k, value(k)), value(k)))
      if (!keys.length) return undefined
      const before: SettingsPatch = {}
      const after: SettingsPatch = {}
      for (const k of keys) {
        Object.assign(before, { [k]: settingsPatchBefore(current, k, value(k)) })
        Object.assign(after, { [k]: value(k) })
      }
      const at = now()
      items.splice(done) // a new edit drops the redo tail
      const top = items[items.length - 1]
      if (top && sameKeys(top.keys, keys) && at - top.at < coalesceMs) {
        top.before = mergeSettingsPatches(before, top.before) // entry keys: the earliest before of each entry wins
        top.after = mergeSettingsPatches(top.after, after)
        top.at = at
        // Dragged back to where it started: the step is gone, not a no-op entry.
        if (same(top.before, top.after)) { items.pop(); done = items.length; return undefined }
        return top
      }
      items.push({ keys, before, after, at })
      if (items.length > cap) items.splice(0, items.length - cap)
      done = items.length
      return items[items.length - 1]
    },
    undo() {
      if (done === 0) return undefined
      done--
      const c = items[done]
      c.at = -Infinity // the next edit must not coalesce into a step that was undone and redone
      return c
    },
    redo() {
      if (done >= items.length) return undefined
      return items[done++]
    },
    canUndo: () => done > 0,
    canRedo: () => done < items.length,
  }
}

/** "fontSize" → "font size": label for the Undo toast, readable without a key→label table. */
export function settingsKeyLabel(keys: readonly string[]): string {
  return keys.map((k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()).join(', ')
}
