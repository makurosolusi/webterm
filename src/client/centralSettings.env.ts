// Env-backed Central settings: one GET of /api/settings/env, writes through its PUT (same path as
// SettingsCostLimit). A write updates the local entry from what the server accepted; no optimistic state.
import { useCallback, useEffect, useState } from 'react'
import type { EnvEntryV2, EnvStateV2 } from '../shared/envSettings.contract'
import { request } from './inboxTransport'

const ENV_PATH = '/api/settings/env'

export type EnvLoad = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; locked: boolean }

export interface CentralEnv {
  load: EnvLoad
  entry(key: string): EnvEntryV2 | undefined
  /** Value in use: the stored override, else what the server runs with, else the default. */
  value(key: string): string
  savingKey: string | null
  saveError: { key: string; message: string } | null
  /** null = remove the override (back to the default). Resolves true when the server accepted. */
  write(key: string, value: string | null): Promise<boolean>
  reload(): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useCentralEnv(): CentralEnv {
  const [load, setLoad] = useState<EnvLoad>({ status: 'loading' })
  const [entries, setEntries] = useState<EnvEntryV2[]>([])
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<CentralEnv['saveError']>(null)

  const reload = useCallback((): void => {
    setLoad({ status: 'loading' })
    request<EnvStateV2>(ENV_PATH).then((st) => {
      setEntries(Array.isArray(st.entries) ? st.entries : [])
      setLoad({ status: 'ready', locked: !!st.locked })
    }).catch((e: unknown) => setLoad({ status: 'error', error: message(e) }))
  }, [])
  useEffect(reload, [reload])

  const entry = (key: string): EnvEntryV2 | undefined => entries.find((e) => e.key === key)
  const value = (key: string): string => {
    const e = entry(key)
    return e ? (e.value || e.effective || e.default || '') : ''
  }

  const write = async (key: string, next: string | null): Promise<boolean> => {
    setSavingKey(key)
    setSaveError(null)
    const change = next === null ? { set: {}, unset: [key] } : { set: { [key]: next }, unset: [] }
    try {
      await request(ENV_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
      setEntries((list) => list.map((e) => (e.key === key ? { ...e, value: next ?? '', effective: next ?? e.default ?? '' } : e)))
      return true
    } catch (e) {
      setSaveError({ key, message: message(e) })
      return false
    } finally {
      setSavingKey(null)
    }
  }

  return { load, entry, value, savingKey, saveError, write, reload }
}
