// Settings › Central Agent: the self-started check-in switch and daily limit, read and written live.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CheckinSettings } from '../shared/centralWork'
import { CENTRAL_API } from './central/centralControlApi'
import { centralErrorMessage } from './central/centralLoad'
import { isAbortError } from './inboxApi'
import { request } from './inboxTransport'
import { InboxApiError } from './inboxTypes'
import { CENTRAL_TEXT } from './centralSettingsLabels'

const PATH = `${CENTRAL_API}/checkin-settings`

function parse(body: unknown): CheckinSettings {
  const b = body as Partial<CheckinSettings> | null
  if (typeof b?.enabled !== 'boolean' || typeof b.dailyLimit !== 'number' || typeof b.usedToday !== 'number') throw new InboxApiError('Check-in settings response malformed', 502, 'bad_response')
  return { enabled: b.enabled, dailyLimit: b.dailyLimit, usedToday: b.usedToday }
}

/** The check-in settings as Settings shows and changes them. */
export interface CheckinApi {
  data: CheckinSettings | null
  error: string | null
  saving: boolean
  saveError: string | null
  save(patch: Partial<Pick<CheckinSettings, 'enabled' | 'dailyLimit'>>): Promise<void>
  reload(): void
}

/** Loads `/api/central/checkin-settings`; a save shows what the server accepted, one at a time. */
export function useCheckinSettings(): CheckinApi {
  const [data, setData] = useState<CheckinSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    setError(null)
    request<unknown>(PATH, { signal: ac.signal }).then(parse).then(
      (next) => { if (!ac.signal.aborted) setData(next) },
      (err: unknown) => { if (!ac.signal.aborted && !isAbortError(err)) setError(centralErrorMessage(err, CENTRAL_TEXT.checkinFailed)) },
    )
    return () => ac.abort()
  }, [tick])

  const save: CheckinApi['save'] = useCallback(async (patch) => {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const reply = await request<unknown>(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      setData(parse(reply))
    } catch (err) {
      setSaveError(centralErrorMessage(err, CENTRAL_TEXT.checkinFailed))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }, [])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, saving, saveError, save, reload }
}
