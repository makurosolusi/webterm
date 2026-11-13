// Settings › Central › Daily spending limit (the one daily cap; it also pauses routines, plans and bake-offs),
// in dollars, over the env override `WEBTERM_CENTRAL_DAILY_COST_MICROS`, written through the same
// `/api/settings/env` PUT Settings › Developer uses: no env advice, the field is the switch. The row has the
// shared anatomy: save status on the label line, modified dot + Reset against the server default, a lock
// line when it cannot change, and a notice with Retry when the value could not be read.
import { useEffect, useState } from 'react'
import type { Lock } from '@/components/ui/disabled-reason'
import type { EnvStateV2 } from '../shared/envSettings.contract'
import { request } from './inboxTransport'
import { CENTRAL_FIELD_TEXT, CENTRAL_TEXT } from './centralSettingsLabels'
import { Field } from './SettingsFields'
import { SettingsCombobox } from './SettingsCombobox'
import { SettingsMessage } from './SettingsMessage'
import { COST_CAP_FIELD_ID, COST_CAP_PRESETS } from './settingsPresets'
import { createSaveStates, useFieldSave } from './settingsSave'
import { centralControlApi } from './central/centralControlApi'

export const COST_CAP_KEY = 'WEBTERM_CENTRAL_DAILY_COST_MICROS'
const ENV_PATH = '/api/settings/env'
const MICROS_PER_DOLLAR = 1_000_000
const ID = 'st-costLimit'

export const COST_TEXT = {
  invalid: 'Enter an amount in dollars, e.g. 5 or 2.50.',
  loadFailed: (why: string): string => `Could not load the limit: ${why}`,
  placeholder: 'No limit',
} as const

/** Dollars text -> micros; '' / 0 = no limit (null). Undefined = not a valid amount. */
export function dollarsToMicros(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, '')
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return undefined
  const micros = Math.round(n * MICROS_PER_DOLLAR)
  return micros === 0 ? null : micros
}

/** Combobox validator for a dollar amount ('' = no limit). */
export const validateDollars = (v: string): string | null => (dollarsToMicros(v) === undefined ? COST_TEXT.invalid : null)

const microsToDollars = (micros: string): string => {
  const n = Number(micros)
  return Number.isFinite(n) && n > 0 ? String(n / MICROS_PER_DOLLAR) : ''
}

/** "$2.50" for a stored dollars text with no preset label (whole dollars stay "$7"). */
export function formatDollars(v: string): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })
}

/** "Spent today: $1.20 of $5.00" (no limit: "Spent today: $1.20"). */
export function spentLine(usedMicros: number, limitMicros: number): string {
  const usd = (m: number): string => '$' + (m / MICROS_PER_DOLLAR).toFixed(2)
  return limitMicros > 0 ? 'Spent today: ' + usd(usedMicros) + ' of ' + usd(limitMicros) : 'Spent today: ' + usd(usedMicros)
}

type Load = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; editable: boolean; known: boolean; fallback: string }

/** The cost cap as a dollars combobox (presets + recent); commits on pick/blur/Enter, empty clears to unlimited. `disabledReason` = shown, field locked. */
export function CostLimitField({ disabledReason }: { disabledReason?: string } = {}): React.JSX.Element | null {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [saved, setSaved] = useState('')
  const [saves] = useState(createSaveStates)
  const save = useFieldSave(saves, COST_CAP_KEY)

  const read = (): void => {
    setLoad({ status: 'loading' })
    request<EnvStateV2>(ENV_PATH).then((st) => {
      const e = st.entries.find((x) => x.key === COST_CAP_KEY)
      setSaved(microsToDollars(e?.value || e?.effective || ''))
      setLoad({ status: 'ready', editable: !!e?.editable && !st.locked, known: !!e, fallback: microsToDollars(e?.default ?? '') })
    }).catch((err: unknown) => setLoad({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
  }
  useEffect(read, [])
  // Live "spent / limit" from Central's own budget counter; Central off (no status) = no line.
  const [spent, setSpent] = useState<string | null>(null)
  const readSpent = (): void => {
    centralControlApi.getStatus().then((st) => setSpent(spentLine(st.budget.used.costMicros ?? 0, st.budget.limits.costMicros ?? 0))).catch(() => setSpent(null))
  }
  useEffect(readSpent, [])

  const commit = async (text: string): Promise<void> => {
    const micros = dollarsToMicros(text)
    if (micros === undefined) return
    const settle = saves.start([COST_CAP_KEY])
    const change = micros === null ? { set: {}, unset: [COST_CAP_KEY] } : { set: { [COST_CAP_KEY]: String(micros) }, unset: [] }
    try {
      await request(ENV_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
      setSaved(micros === null ? '' : String(micros / MICROS_PER_DOLLAR))
      settle({ ok: true })
      readSpent()
    } catch (err) {
      settle({ ok: false, message: err instanceof Error ? err.message : String(err), retry: () => { void commit(text) } })
    }
  }

  const ready = load.status === 'ready' ? load : null
  const lock: Lock | undefined = disabledReason ? { reason: disabledReason }
    : ready && !ready.known ? { reason: CENTRAL_TEXT.unavailable }
    : ready && !ready.editable ? { reason: CENTRAL_TEXT.locked }
    : undefined
  const saving = save?.status === 'saving'
  const fallback = ready?.fallback ?? ''
  return (
    <Field label={CENTRAL_FIELD_TEXT.costLimit.label} hint={CENTRAL_FIELD_TEXT.costLimit.hint} htmlFor={ID} field="central.costLimit"
      lock={lock} save={save} modified={ready !== null && saved !== fallback} onReset={() => { void commit(fallback) }}>
      {spent ? <span className="st-hint" role="status" data-spent>{spent}</span> : null}
      {load.status === 'error'
        ? <SettingsMessage kind="error" action={{ label: CENTRAL_TEXT.retry, run: read }}>{COST_TEXT.loadFailed(load.error)}</SettingsMessage>
        : <SettingsCombobox id={ID} ariaLabel={CENTRAL_FIELD_TEXT.costLimit.label} fieldId={COST_CAP_FIELD_ID} presets={COST_CAP_PRESETS}
            placeholder={load.status === 'loading' ? CENTRAL_TEXT.loading : COST_TEXT.placeholder} format={formatDollars}
            value={saved} disabled={!ready || lock !== undefined || saving} validate={validateDollars} onCommit={(v) => void commit(v)} />}
    </Field>
  )
}
