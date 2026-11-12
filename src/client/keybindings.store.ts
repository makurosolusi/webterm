// User keybinding overrides, VS Code `keybindings.json` style: command id → chord, or `null` to
// remove the default. Persisted in server settings (`Settings.keybindings`, PUT /api/settings);
// this module is the synchronous in-memory view the dispatcher and overlay read, kept in step by
// `useKeybindingsSync` in App. Overrides from the earlier per-browser store (localStorage) are
// migrated into settings once, then that key is removed.
import { useEffect, useSyncExternalStore } from 'react'
import type { Settings } from '../shared/settings'

/** Legacy per-browser location, read once for migration. */
export const KEYBINDINGS_STORAGE_KEY = 'webterm.keybindings'
export type KeybindingOverrides = Readonly<Record<string, string | null>>

let current: KeybindingOverrides = Object.freeze({})
let persist: ((next: Record<string, string | null>) => void) | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

function save(next: Record<string, string | null>): void {
  current = next
  emit()
  persist?.(next)
}

export const keybindingOverrides = (): KeybindingOverrides => current
/**
 * Bind `commandId` to `chord`; `null` removes its keybinding. The key moves to the end, so key
 * order is write order: the dispatcher lets the most recent override win a conflict.
 */
export function setKeybinding(commandId: string, chord: string | null): void {
  const rest = { ...current }
  delete rest[commandId]
  save({ ...rest, [commandId]: chord })
}
/** Back to the command's default keybinding. */
export function resetKeybinding(commandId: string): void {
  const rest = { ...current }
  delete rest[commandId]
  save(rest)
}

/** Every command back to its default keybinding. */
export const resetAllKeybindings = (): void => save({})

/** Point the store at a settings value and a writer (App does this; tests may pass a stub). */
export function connectKeybindings(value: KeybindingOverrides, write: ((next: Record<string, string | null>) => void) | null): void {
  current = value
  persist = write
  emit()
}

/** Command ids that were renamed; an override under the old id moves to the new one. */
export const RENAMED_COMMAND_IDS: Readonly<Record<string, string>> = {
  'output.toggle.key': 'output.toggle',
  'view.cleanView.key': 'view.cleanView',
}

/** `value` with renamed ids moved (an existing override under the new id wins), or null when none apply. */
export function migrateCommandIds(value: KeybindingOverrides): Record<string, string | null> | null {
  if (!Object.keys(value).some((k) => Object.hasOwn(RENAMED_COMMAND_IDS, k))) return null
  const out: Record<string, string | null> = {}
  for (const [k, v] of Object.entries(value)) {
    const id = RENAMED_COMMAND_IDS[k] ?? k
    if (id === k || !Object.hasOwn(value, id)) out[id] = v
  }
  return out
}

/** Legacy localStorage overrides, or null when there are none / storage is unreadable. */
export function takeLegacyKeybindings(): Record<string, string | null> | null {
  try {
    const raw = localStorage.getItem(KEYBINDINGS_STORAGE_KEY)
    if (raw === null) return null
    localStorage.removeItem(KEYBINDINGS_STORAGE_KEY)
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    return Object.fromEntries(Object.entries(v).filter(([, c]) => c === null || typeof c === 'string'))
  } catch (e) {
    console.warn('keybindings: legacy overrides unreadable, skipped', e instanceof Error ? e.name : 'unknown')
    return null
  }
}

/**
 * Keeps the store in step with server settings. After the first load, legacy localStorage
 * overrides are merged under the server ones (server wins a clash), renamed command ids are moved,
 * and the result is written back once.
 */
export function useKeybindingsSync(value: Settings['keybindings'], hydrated: boolean, update: (patch: Partial<Settings>) => void): void {
  useEffect(() => {
    if (!hydrated) return
    connectKeybindings(value, (next) => update({ keybindings: next }))
  }, [value, hydrated, update])
  useEffect(() => {
    if (!hydrated) return
    const legacy = takeLegacyKeybindings()
    const merged = legacy && Object.keys(legacy).length ? { ...legacy, ...current } : null
    const next = migrateCommandIds(merged ?? current) ?? merged
    if (next) save(next)
    // Only `hydrated` as dep: the migration runs once, on first load; `current` is the value
    // the effect above just connected.
  }, [hydrated])
}

/** Calls `l` whenever the overrides change; returns the unsubscribe. */
export const subscribeKeybindings = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useKeybindingOverrides = (): KeybindingOverrides => useSyncExternalStore(subscribeKeybindings, keybindingOverrides)
