// Hook kemampuan: cache modul bersama + refresh; mutasi menunggu server (tanpa optimistis).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CapabilitiesResponse, CapabilityId } from '../shared/featureCapabilities'
import { CapabilitiesApiError, fetchCapabilities, setCapability, setCapabilitySub } from './capabilitiesApi'
import { CAPABILITY_TEXT } from './capabilitiesLabels'

const HTTP_FORBIDDEN = 403

let cache: CapabilitiesResponse | null = null
let inflight: Promise<CapabilitiesResponse> | null = null
const listeners = new Set<() => void>()

function publish(next: CapabilitiesResponse): void {
  cache = next
  for (const l of listeners) l()
}

/** Kosongkan cache modul (untuk tes). */
export function resetCapabilitiesCache(): void {
  cache = null
  inflight = null
  for (const l of listeners) l()
}

/** User-facing message for an API error; never the raw body or code. 403 = the UI session ended. */
export function capabilityErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof CapabilitiesApiError) || e.status !== HTTP_FORBIDDEN) return fallback
  return CAPABILITY_TEXT.forbidden
}

/** Outcome of a load, so a caller's own button can say what happened (the hook's `error` stays for the section top). */
export type CapabilitiesLoad = { ok: true; data: CapabilitiesResponse } | { ok: false; error: string }

export interface CapabilitiesApi {
  data: CapabilitiesResponse | null
  loading: boolean
  error: string | null
  /** The capability whose change failed (its card shows `error`); null = a load error (section top). */
  errorId: CapabilityId | null
  /** Id yang sedang diubah (untuk aria-busy), atau null. */
  busyId: CapabilityId | null
  refresh(): Promise<CapabilitiesLoad>
  /** Reload with fresh detection (skips the sign-in probe cache); for "Check again". */
  recheck(): Promise<CapabilitiesLoad>
  /** Resolve true bila server menerima; false + `error` terisi bila gagal. */
  toggle(id: CapabilityId, enabled: boolean): Promise<boolean>
  setSub(id: CapabilityId, key: string, on: boolean): Promise<boolean>
}

/** State kemampuan dari server; memuat sekali per modul, `refresh()` memaksa muat ulang. */
export function useCapabilities(): CapabilitiesApi {
  const data = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => cache)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<CapabilityId | null>(null)
  const [busyId, setBusyId] = useState<CapabilityId | null>(null)

  // `fresh` tak boleh menumpang muatan biasa yang sedang jalan (hasilnya masih dari cache): selalu panggilan sendiri.
  const load = useCallback(async (fresh: boolean): Promise<CapabilitiesLoad> => {
    setLoading(true)
    try {
      const data = fresh ? await fetchCapabilities(true) : await (inflight ??= fetchCapabilities().finally(() => { inflight = null }))
      publish(data)
      setError(null)
      setErrorId(null)
      return { ok: true, data }
    } catch (e) {
      const error = capabilityErrorMessage(e, CAPABILITY_TEXT.loadFailed)
      setError(error)
      setErrorId(null)
      return { ok: false, error }
    } finally {
      setLoading(false)
    }
  }, [])
  const refresh = useCallback(() => load(false), [load])
  const recheck = useCallback(() => load(true), [load])

  const mutate = useCallback(async (id: CapabilityId, run: () => Promise<CapabilitiesResponse>) => {
    setBusyId(id)
    try {
      publish(await run())
      setError(null)
      setErrorId(null)
      return true
    } catch (e) {
      setError(capabilityErrorMessage(e, CAPABILITY_TEXT.changeFailed))
      setErrorId(id)
      return false
    } finally {
      setBusyId(null)
    }
  }, [])

  useEffect(() => { if (cache === null) void refresh() }, [refresh])

  const toggle = useCallback((id: CapabilityId, enabled: boolean) => mutate(id, () => setCapability(id, enabled)), [mutate])
  const setSub = useCallback((id: CapabilityId, key: string, on: boolean) => mutate(id, () => setCapabilitySub(id, key, on)), [mutate])
  return { data, loading, error, errorId, busyId, refresh, recheck, toggle, setSub }
}
