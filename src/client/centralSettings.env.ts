// Env-backed Central settings: one GET of /api/settings/env, writes through its PUT (same path as
// SettingsCostLimit). A write shows the chosen value at once (pending), then the server's answer: the
// local entry on success, the old value plus an inline error (with Retry) on failure. Status per key.
import { useCallback, useEffect, useReducer, useState } from 'react'
import type { EnvEntryV2, EnvStateV2 } from '../shared/envSettings.contract'
import { request } from './inboxTransport'
import { createSaveStates, type FieldSave } from './settingsSave'

const ENV_PATH = '/api/settings/env'

export type EnvLoad = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; locked: boolean }

export interface CentralEnv {
  load: EnvLoad
  entry(key: string): EnvEntryV2 | undefined
  /** Value shown: the pending pick, else the stored override, else what the server runs with, else the default. */
  value(key: string): string
  /** The shown override differs from the registry default (Field's modified dot + Reset). */
  modified(key: string): boolean
  /** Saving… / Saved / error + Retry of this key. */
  saveState(key: string): FieldSave | undefined
  /** null = remove the override (back to the default). Resolves true when the server accepted. */
  write(key: string, value: string | null): Promise<boolean>
  reload(): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useCentralEnv(): CentralEnv {
  const [load, setLoad] = useState<EnvLoad>({ status: 'loading' })
  const [entries, setEntries] = useState<EnvEntryV2[]>([])
  // key -> picked value (null = reset) while its PUT is in flight.
  const [pending, setPending] = useState<ReadonlyMap<string, string | null>>(new Map())
  const [saves] = useState(createSaveStates)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => saves.subscribe(rerender), [saves])

  const reload = useCallback((): void => {
    setLoad({ status: 'loading' })
    request<EnvStateV2>(ENV_PATH).then((st) => {
      setEntries(Array.isArray(st.entries) ? st.entries : [])
      setLoad({ status: 'ready', locked: !!st.locked })
    }).catch((e: unknown) => setLoad({ status: 'error', error: message(e) }))
  }, [])
  useEffect(reload, [reload])

  const entry = (key: string): EnvEntryV2 | undefined => entries.find((e) => e.key === key)
  const override = (key: string): string => (pending.has(key) ? pending.get(key) ?? '' : entry(key)?.value ?? '')
  const value = (key: string): string => {
    const e = entry(key)
    if (!e) return ''
    if (pending.has(key)) return pending.get(key) ?? e.default ?? ''
    return e.value || e.effective || e.default || ''
  }
  const modified = (key: string): boolean => {
    const o = override(key)
    return entry(key) !== undefined && o !== '' && o !== (entry(key)?.default ?? '')
  }

  const write = async (key: string, next: string | null): Promise<boolean> => {
    setPending((m) => new Map(m).set(key, next))
    const settle = saves.start([key])
    const change = next === null ? { set: {}, unset: [key] } : { set: { [key]: next }, unset: [] }
    try {
      await request(ENV_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
      setEntries((list) => list.map((e) => (e.key === key ? { ...e, value: next ?? '', effective: next ?? e.default ?? '' } : e)))
      settle({ ok: true })
      return true
    } catch (e) {
      settle({ ok: false, message: message(e), retry: () => { void write(key, next) } })
      return false
    } finally {
      // Only this write's pick: a newer pick of the same key stays shown until its own answer.
      setPending((m) => {
        if (!m.has(key) || m.get(key) !== next) return m
        const rest = new Map(m)
        rest.delete(key)
        return rest
      })
    }
  }

  return { load, entry, value, modified, saveState: saves.get, write, reload }
}
