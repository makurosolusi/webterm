// Per-key save state for Settings fields (Saving… / Saved ✓ / error + Retry), shared by every store that saves a
// field to the server: the settings row (useSettings), env-backed rows (centralSettings.env), check-ins.
// Keyed, not one slot: two fields saving at once must not clear each other's status. A newer save of a key
// supersedes an older one, so a late reply never overwrites the status of the edit the user made after it.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export type FieldSave =
  | { status: 'saving' }
  /** `where: 'browser'`: kept in this browser only (localStorage prefs), said so in the status. */
  | { status: 'saved'; where?: 'browser' }
  | { status: 'error'; message: string; retry(): void }

export type SaveResult = { ok: true } | { ok: false; message: string; retry(): void }

/** How long "Saved ✓" stays next to a field: long enough to notice after looking back from the control. */
export const SAVED_SHOW_MS = 3000

export interface SaveStates {
  get(key: string): FieldSave | undefined
  /** Marks `keys` saving; the returned function settles those not taken over by a newer save since. */
  start(keys: readonly string[]): (result: SaveResult) => void
  subscribe(listener: () => void): () => void
}

export function createSaveStates(): SaveStates {
  const states = new Map<string, FieldSave>()
  const owner = new Map<string, number>()
  const listeners = new Set<() => void>()
  let seq = 0
  const emit = (): void => { for (const l of listeners) l() }
  return {
    get: (key) => states.get(key),
    start(keys) {
      const token = ++seq
      for (const k of keys) { owner.set(k, token); states.set(k, { status: 'saving' }) }
      emit()
      return (result) => {
        const mine = keys.filter((k) => owner.get(k) === token)
        if (!mine.length) return
        for (const k of mine) states.set(k, result.ok ? { status: 'saved' } : { status: 'error', message: result.message, retry: result.retry })
        emit()
        if (!result.ok) return
        setTimeout(() => {
          const still = mine.filter((k) => owner.get(k) === token)
          for (const k of still) states.delete(k)
          if (still.length) emit()
        }, SAVED_SHOW_MS)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const none = (): undefined => undefined
const noop = (): (() => void) => () => undefined

/** Live save state of one key (undefined store or key = nothing to show). */
export function useFieldSave(store: SaveStates | undefined, key: string | undefined): FieldSave | undefined {
  return useSyncExternalStore(store?.subscribe ?? noop, store && key ? () => store.get(key) : none)
}

/** A failed request's reason for the inline error: the server's `error` text when it sent one, else the status. */
export async function responseError(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return new Error(typeof body?.error === 'string' && body.error ? body.error : `${what} -> ${res.status}`)
}

/** Save state of a row stored in this browser (no request): `mark()` after each change shows
 *  "Saved on this browser" for `SAVED_SHOW_MS`. */
export function useLocalFieldSave(): [FieldSave | undefined, () => void] {
  const [save, setSave] = useState<FieldSave | undefined>()
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const mark = (): void => {
    window.clearTimeout(timer.current)
    setSave({ status: 'saved', where: 'browser' })
    timer.current = window.setTimeout(() => setSave(undefined), SAVED_SHOW_MS)
  }
  return [save, mark]
}
