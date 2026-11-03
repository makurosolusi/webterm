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

/** Pesan Indonesia untuk galat API; tidak memuat body atau kode mentah. */
export function capabilityErrorMessage(e: unknown, fallback: string): string {
  return e instanceof CapabilitiesApiError && e.status === HTTP_FORBIDDEN ? CAPABILITY_TEXT.forbidden : fallback
}

export interface CapabilitiesApi {
  data: CapabilitiesResponse | null
  loading: boolean
  error: string | null
  /** Id yang sedang diubah (untuk aria-busy), atau null. */
  busyId: CapabilityId | null
  refresh(): Promise<void>
  /** Resolve true bila server menerima; false + `error` terisi bila gagal. */
  toggle(id: CapabilityId, enabled: boolean): Promise<boolean>
  setSub(id: CapabilityId, key: string, on: boolean): Promise<boolean>
}

/** State kemampuan dari server; memuat sekali per modul, `refresh()` memaksa muat ulang. */
export function useCapabilities(): CapabilitiesApi {
  const data = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => cache)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<CapabilityId | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      inflight ??= fetchCapabilities().finally(() => { inflight = null })
      publish(await inflight)
      setError(null)
    } catch (e) {
      setError(capabilityErrorMessage(e, CAPABILITY_TEXT.loadFailed))
    } finally {
      setLoading(false)
    }
  }, [])

  const mutate = useCallback(async (id: CapabilityId, run: () => Promise<CapabilitiesResponse>) => {
    setBusyId(id)
    try {
      publish(await run())
      setError(null)
      return true
    } catch (e) {
      setError(capabilityErrorMessage(e, CAPABILITY_TEXT.changeFailed))
      return false
    } finally {
      setBusyId(null)
    }
  }, [])

  useEffect(() => { if (cache === null) void refresh() }, [refresh])

  const toggle = useCallback((id: CapabilityId, enabled: boolean) => mutate(id, () => setCapability(id, enabled)), [mutate])
  const setSub = useCallback((id: CapabilityId, key: string, on: boolean) => mutate(id, () => setCapabilitySub(id, key, on)), [mutate])
  return { data, loading, error, busyId, refresh, toggle, setSub }
}
