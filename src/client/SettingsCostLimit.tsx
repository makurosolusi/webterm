// Settings › Central Agent › Daily spending limit (dollars) over the existing env override `WEBTERM_CENTRAL_DAILY_COST_MICROS`,
// written through the same `/api/settings/env` PUT Settings › Developer uses: no env advice, the field is the switch.
import { useEffect, useState } from 'react'
import type { EnvStateV2 } from '../shared/envSettings.contract'
import { request } from './inboxTransport'
import { Field } from './SettingsFields'
import { SettingsCombobox } from './SettingsCombobox'
import { COST_CAP_FIELD_ID, COST_CAP_PRESETS } from './settingsPresets'

export const COST_CAP_KEY = 'WEBTERM_CENTRAL_DAILY_COST_MICROS'
const ENV_PATH = '/api/settings/env'
const MICROS_PER_DOLLAR = 1_000_000

/** Dollars text -> micros; '' / 0 = no limit (null). Undefined = not a valid amount. */
export function dollarsToMicros(text: string): number | null | undefined {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return undefined
  const micros = Math.round(n * MICROS_PER_DOLLAR)
  return micros === 0 ? null : micros
}

/** Combobox validator for a dollar amount ('' = no limit). */
export const validateDollars = (v: string): string | null =>
  dollarsToMicros(v) === undefined ? 'Enter an amount in dollars, e.g. 5 or 2.50.' : null

const microsToDollars = (micros: string): string => {
  const n = Number(micros)
  return Number.isFinite(n) && n > 0 ? String(n / MICROS_PER_DOLLAR) : ''
}

type Load = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; editable: boolean; reason?: string }

/** The cost cap as a dollars combobox (presets + recent); commits on pick/blur/Enter, empty clears to unlimited. `disabledReason` = shown, field locked. */
export function CostLimitField({ disabledReason }: { disabledReason?: string } = {}): React.JSX.Element | null {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [saved, setSaved] = useState('')
  const [saveError, setSaveError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const read = (): void => {
    setLoad({ status: 'loading' })
    request<EnvStateV2>(ENV_PATH).then((st) => {
      const e = st.entries.find((x) => x.key === COST_CAP_KEY)
      const dollars = microsToDollars(e?.value ?? '')
      setSaved(dollars)
      setLoad({ status: 'ready', editable: !!e?.editable && !st.locked, reason: e ? undefined : 'Not available on this server.' })
    }).catch((err: unknown) => setLoad({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
  }
  useEffect(read, [])

  const commit = async (text: string): Promise<void> => {
    const micros = dollarsToMicros(text)
    if (micros === undefined) return
    setSaving(true)
    setSaveError(undefined)
    const change = micros === null ? { set: {}, unset: [COST_CAP_KEY] } : { set: { [COST_CAP_KEY]: String(micros) }, unset: [] }
    try {
      await request(ENV_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
      const next = micros === null ? '' : String(micros / MICROS_PER_DOLLAR)
      setSaved(next)
    } catch (err) {
      setSaveError(`Could not save the limit: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const disabled = load.status !== 'ready' || !load.editable || saving || disabledReason !== undefined
  return (
    <Field
      label="Daily spending limit"
      htmlFor="st-costLimit"
      field="central.costLimit"
      hint="Dollars per UTC day; empty = no limit. At 80% work moves to cheaper models, at 100% only Haiku runs."
    >
      <span className="st-unit">$</span>
      <SettingsCombobox id="st-costLimit" fieldId={COST_CAP_FIELD_ID} presets={COST_CAP_PRESETS} placeholder="No limit"
        value={saved} disabled={disabled} validate={validateDollars} onCommit={(v) => void commit(v)} />
      {disabledReason ? <span className="st-hint" data-reason>{disabledReason}</span> : null}
      {load.status === 'loading' ? <span className="st-hint" role="status">Loading…</span> : null}
      {saving ? <span className="st-hint" role="status">Saving…</span> : null}
      {load.status === 'ready' && !load.editable ? <span className="st-hint">{load.reason ?? 'Locked by the server environment.'}</span> : null}
      {load.status === 'error' ? (
        <span role="alert" className="st-hint">
          {`Could not load the limit: ${load.error}`} <button type="button" className="st-button" onClick={read}>Retry</button>
        </span>
      ) : null}
      {saveError ? <span role="alert" className="st-hint">{saveError}</span> : null}
    </Field>
  )
}
