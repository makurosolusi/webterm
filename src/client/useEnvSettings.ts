// State section Environment: muat sekali, ganti state dari respons PUT, kumpulkan kunci yang
// butuh restart. Nilai yang dikirim (termasuk secret) tidak pernah disimpan di sini.
import { useCallback, useEffect, useRef, useState } from 'react'
import { envErrorMessage, fetchEnv, putEnv, type EnvChange, type EnvState } from './envSettingsApi'

export interface EnvSettingsHook {
  loading: boolean
  state: EnvState | null
  /** Error muat (state lama tetap tampil). */
  error: string | null
  /** Error simpan per KEY. */
  entryErrors: Record<string, string>
  busy: boolean
  /** Kunci yang sudah diubah dan butuh restart (kumulatif selama section terbuka). */
  restartKeys: string[]
  refresh: () => void
  /** Kirim satu perubahan untuk `key`; true bila sukses. */
  apply: (key: string, change: EnvChange) => Promise<boolean>
}

/** Hook data env; hanya pasang saat section terlihat. */
export function useEnvSettings(): EnvSettingsHook {
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<EnvState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [restartKeys, setRestartKeys] = useState<string[]>([])
  const alive = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchEnv()
      if (!alive.current) return
      setState(next)
      setError(null)
    } catch (e) {
      if (alive.current) setError(envErrorMessage(e))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false }
  }, [load])

  const apply = useCallback(async (key: string, change: EnvChange): Promise<boolean> => {
    setBusy(true)
    setEntryErrors((prev) => ({ ...prev, [key]: '' }))
    try {
      const { restartRequired, ...next } = await putEnv(change)
      if (!alive.current) return true
      setState(next)
      setRestartKeys((prev) => [...new Set([...prev, ...restartRequired])])
      return true
    } catch (e) {
      if (alive.current) setEntryErrors((prev) => ({ ...prev, [key]: envErrorMessage(e) }))
      return false
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [])

  const refresh = useCallback(() => void load(), [load])

  return { loading, state, error, entryErrors, busy, restartKeys, refresh, apply }
}
