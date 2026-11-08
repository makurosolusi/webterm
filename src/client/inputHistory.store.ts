// Client copy of Settings `inputHistory` for SettingsCombobox. Seeded once from the live settings the
// app already loaded (no extra GET), then kept here and written as one-entry PATCHes straight to
// PUT /api/settings, outside the Settings undo history: remembering a value is not a settings change.
import { useEffect, useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings'
import { pushHistory } from '../shared/settings.inputHistory'
import { settingsUrl, useLiveSettings } from './useSettings'

type History = Record<string, string[]>

let state: History = {}
let loaded = false
const subs = new Set<() => void>()
const emit = (): void => { for (const f of subs) f() }

/** Take the stored history from loaded settings, once. `DEFAULT_SETTINGS` itself = not loaded yet
 *  (outside the provider or before the first GET): writing then would replace the stored lists. */
export function seedInputHistory(settings: Settings): void {
  if (loaded || settings === DEFAULT_SETTINGS) return
  state = settings.inputHistory
  loaded = true
  emit()
}

async function save(fieldId: string, list: string[]): Promise<void> {
  state = { ...state, [fieldId]: list }
  emit()
  const res = await fetch(settingsUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputHistory: { [fieldId]: list.length ? list : null } }),
  })
  if (!res.ok) throw new Error(`save input history for ${fieldId}: PUT /api/settings -> ${res.status}`)
}

const report = (err: unknown): void => console.warn(err instanceof Error ? err.message : String(err))

/** Put `value` first in `fieldId`'s history (no-op until the stored history is known). */
export function rememberInput(fieldId: string, value: string): Promise<void> {
  if (!loaded) return Promise.resolve()
  const before = state[fieldId] ?? []
  const next = pushHistory(before, value)
  return JSON.stringify(next) === JSON.stringify(before) ? Promise.resolve() : save(fieldId, next).catch(report)
}

/** Remove one remembered value. */
export function forgetInput(fieldId: string, value: string): Promise<void> {
  if (!loaded) return Promise.resolve()
  return save(fieldId, (state[fieldId] ?? []).filter((x) => x !== value)).catch(report)
}

const EMPTY: readonly string[] = []

/** The remembered values of one field, most recent first; seeds the store from the live settings. */
export function useInputHistory(fieldId: string): readonly string[] {
  const live = useLiveSettings()
  useEffect(() => seedInputHistory(live), [live])
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f) } },
    () => state[fieldId] ?? EMPTY,
  )
}

/** Test-only: forget the loaded copy. */
export function resetInputHistoryForTests(): void { state = {}; loaded = false }
