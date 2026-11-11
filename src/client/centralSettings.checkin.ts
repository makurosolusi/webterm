// Settings › Central Agent: the self-started check-in switch and daily limit, read and written live.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CheckinSettings } from '../shared/centralWork'
import { CENTRAL_API } from './central/centralControlApi'
import { centralErrorMessage } from './central/centralLoad'
import { isAbortError } from './inboxApi'
import { request } from './inboxTransport'
import { InboxApiError } from './inboxTypes'
import { CENTRAL_TEXT } from './centralSettingsLabels'
import { createSaveStates, type FieldSave } from './settingsSave'
import { reloadSettings } from './useSettings'

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
  /** Saving… / Saved / error + Retry of one key. */
  saveState(key: 'enabled' | 'dailyLimit'): FieldSave | undefined
  save(patch: Partial<Pick<CheckinSettings, 'enabled' | 'dailyLimit'>>): Promise<void>
  reload(): void
}

/** Loads `/api/central/checkin-settings`; a save shows the pick at once, then what the server accepted (the old
 *  value + an inline error on failure), one at a time. The values live in the settings row, so a save also
 *  re-reads settings: the panel's copy must not go stale. */
export function useCheckinSettings(): CheckinApi {
  const [data, setData] = useState<CheckinSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saves] = useState(createSaveStates)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => saves.subscribe(rerender), [saves])
  const latest = useRef<CheckinSettings | null>(null)
  latest.current = data
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

  const save: CheckinApi['save'] = useCallback(async function save(patch) {
    if (inFlight.current) return
    inFlight.current = true
    setSaving(true)
    const before = latest.current
    if (before) setData({ ...before, ...patch })
    const settle = saves.start(Object.keys(patch))
    try {
      const reply = await request<unknown>(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      setData(parse(reply))
      settle({ ok: true })
      void reloadSettings()
    } catch (err) {
      setData(before)
      settle({ ok: false, message: centralErrorMessage(err, CENTRAL_TEXT.checkinFailed), retry: () => { void save(patch) } })
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }, [saves])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, saving, saveState: saves.get, save, reload }
}
