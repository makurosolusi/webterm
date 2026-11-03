// Provider state Environment (kontrak c-0): state server + draft terpusat + simpan massal atomik.
// Fetch lazy (saat ada konsumen section atau query terisi), cache selama provider hidup. Secret ikut
// draft dan simpan massal (nilainya tak pernah masuk state/log); Hapus = reset → unset langsung.
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EnvStateV2 } from '../shared/envSettings.contract'
import { buildChange, dropSent, reconcileDraft, valueOfKey, withDraft } from './envDraft'
import { envErrorMessage, fetchEnv, putEnv, type EnvChange } from './envSettingsApi'

export interface EnvSettingsApi {
  state: EnvStateV2 | null
  loading: boolean
  error: string | null
  draft: ReadonlyMap<string, string>
  dirtyKeys: string[]
  setDraft(k: string, v: string): void
  discard(): void
  /** Kirim semua draft dalam satu PUT; menolak (dan mengisi `error`) bila gagal. */
  save(): Promise<void>
  /** Hapus override satu kunci langsung (draft kunci lain utuh); tidak menolak, gagal → `error`. */
  reset(k: string): Promise<void>
  refresh(): Promise<void>
  valueOf(k: string): string | undefined
  query: string
}

const ApiCtx = createContext<EnvSettingsApi | null>(null)
const RequestCtx = createContext<() => void>(() => undefined)

/** Ada provider di atas? EnvSection memasang provider sendiri bila belum. */
export function useHasEnvSettingsContext(): boolean {
  return useContext(ApiCtx) !== null
}

/** Minta provider memuat state (lazy); dipanggil section yang tampil. */
export function useEnvLoadOnMount(): void {
  const request = useContext(RequestCtx)
  useEffect(() => { request() }, [request])
}

/** Akses provider; melempar bila dipanggil di luar EnvSettingsProvider. */
export function useEnvSettingsContext(): EnvSettingsApi {
  const api = useContext(ApiCtx)
  if (!api) throw new Error('useEnvSettingsContext harus dipakai di dalam EnvSettingsProvider')
  return api
}

/** Provider state env + draft; `query` = kueri pencarian Settings (tidak menghapus draft). */
export function EnvSettingsProvider(props: { children: ReactNode; query: string }): React.JSX.Element {
  const { children, query } = props
  const [state, setState] = useState<EnvStateV2 | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraftMap] = useState<ReadonlyMap<string, string>>(new Map())
  const [wanted, setWanted] = useState(false)
  const started = useRef(false)
  const alive = useRef(true)
  const stateRef = useRef<EnvStateV2 | null>(null)
  const draftRef = useRef(draft)
  stateRef.current = state
  draftRef.current = draft

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const adopt = useCallback((next: EnvStateV2): void => {
    setState(next)
    setDraftMap((prev) => reconcileDraft(prev, next.entries))
    setError(null)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const next = await fetchEnv()
      if (alive.current) adopt(next)
    } catch (e) {
      if (alive.current) setError(envErrorMessage(e))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [adopt])

  useEffect(() => {
    if (!(wanted || query !== '') || started.current) return
    started.current = true
    void refresh()
  }, [wanted, query, refresh])

  /** Kirim satu PUT; true bila sukses, gagal → `error` terisi. */
  const send = useCallback(async (change: EnvChange): Promise<boolean> => {
    try {
      const next = await putEnv(change)
      if (alive.current) adopt(next)
      return true
    } catch (e) {
      if (alive.current) setError(envErrorMessage(e))
      return false
    }
  }, [adopt])

  const setDraft = useCallback((k: string, v: string): void => {
    const entry = stateRef.current?.entries.find((x) => x.key === k)
    if (!entry || !entry.editable || stateRef.current?.locked) return
    setDraftMap((prev) => withDraft(prev, k, v, entry.value))
  }, [])

  const save = useCallback(async (): Promise<void> => {
    const change = buildChange(draftRef.current)
    const sent = change.set ?? {}
    if (Object.keys(sent).length === 0) return
    if (!(await send(change))) throw new Error('env settings: simpan perubahan gagal')
    if (alive.current) setDraftMap((prev) => dropSent(prev, sent))
  }, [send])

  const reset = useCallback(async (k: string): Promise<void> => {
    setDraftMap((prev) => { const n = new Map(prev); n.delete(k); return n })
    await send({ unset: [k] })
  }, [send])

  const discard = useCallback((): void => { setDraftMap(new Map()); setError(null) }, [])
  const request = useCallback(() => setWanted(true), [])
  const api = useMemo<EnvSettingsApi>(() => ({
    state, loading, error, draft, query, dirtyKeys: [...draft.keys()],
    setDraft, discard, save, reset, refresh,
    valueOf: (k) => valueOfKey(state?.entries ?? [], draft, k),
  }), [state, loading, error, draft, query, setDraft, discard, save, reset, refresh])

  return createElement(RequestCtx.Provider, { value: request }, createElement(ApiCtx.Provider, { value: api }, children))
}
