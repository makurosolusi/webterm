// Cost section of the Control tab (F4-e): what Claude Code agents and Central spent today / over 7
// days by workspace, agent, routine and model, the cache hit rate, and the caps that auto-pause work.
// Numbers come from GET /api/cost (src/server/cost/cost.route.ts); prices are estimates, not a bill.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SettingsCombobox } from './SettingsCombobox'
import { dollarsToMicros, validateDollars } from './SettingsCostLimit'
import { COST_CAP_FIELD_ID, COST_CAP_PRESETS } from './settingsPresets'
import { controlRequest } from './ControlPanel'
import type { CostResponse } from '../server/cost/cost.route'
import type { SpendGroup, SpendSummary } from '../server/cost/costStore'

export const COST_API_PATH = '/api/cost'

export const COST_TEXT = {
  title: 'Cost',
  intro: 'Estimated spend of Claude Code agents and Central, from their own usage data. Not a bill.',
  today: 'Today',
  week: '7 days',
  unavailable: 'Cost data is unavailable (the ledger is off).',
  loading: 'Loading cost…',
  spend: 'Spend',
  responses: 'Responses',
  cacheHit: 'Cache hit rate',
  prefixReuse: 'Central prefix reuse (7 days)',
  prefixValue: (rate: number | null, n: number) => (rate === null ? '—' : `${Math.round(rate * 100)}% of ${n} prefix${n === 1 ? '' : 'es'}`),
  unpriced: (n: number) => `${n} responses from models without a price are not counted.`,
  byWorkspace: 'By workspace',
  topSpenders: 'Top spenders',
  byRoutine: 'By routine / DAG',
  byModel: 'By model',
  central: 'Central',
  none: 'Nothing yet.',
  caps: 'Caps',
  dayCap: 'Daily cap (USD)',
  resume: 'Resume',
  paused: 'Paused',
  pricing: 'Prices from',
} as const

export const formatUsd = (micros: number): string => `$${(micros / 1e6).toFixed(micros > 0 && micros < 10_000 ? 4 : 2)}`
const isCost = (v: unknown): v is CostResponse => !!v && typeof (v as CostResponse).today === 'object' && Array.isArray((v as CostResponse).caps)

function label(data: CostResponse, prefix: string, key: string): string {
  if (key === '') return COST_TEXT.central
  return data.labels[`${prefix}:${key}`] ?? key
}

function Groups({ title, rows, name }: { title: string; rows: SpendGroup[]; name: (key: string) => string }): React.JSX.Element {
  return (
    <div>
      <h4 className="text-xs font-semibold">{title}</h4>
      {rows.length === 0 ? <p className="text-xs opacity-70">{COST_TEXT.none}</p> : (
        <ul className="text-xs">
          {rows.map((g) => <li key={g.key} className="flex justify-between gap-2"><span className="truncate">{name(g.key)}</span><span>{formatUsd(g.costMicros)}</span></li>)}
        </ul>
      )}
    </div>
  )
}

export function CostPanel(): React.JSX.Element {
  const [data, setData] = useState<CostResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [range, setRange] = useState<'today' | 'week'>('today')

  const load = useCallback(() => {
    controlRequest('GET', undefined, '', COST_API_PATH)
      .then((v) => { if (isCost(v)) { setData(v); setFailed(false) } else setFailed(true) })
      .catch(() => setFailed(true)) // shown as the unavailable line
  }, [])
  useEffect(load, [load])

  const write = (method: string, path: string, body: unknown): void => {
    controlRequest(method, body, '', path).then(load, () => setFailed(true))
  }

  const s: SpendSummary | undefined = data?.[range]
  const day = data?.caps.find((c) => c.scope === 'day')
  return (
    <section aria-label={COST_TEXT.title} data-testid="cost-panel">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{COST_TEXT.title}</h3>
        <Button size="sm" variant={range === 'today' ? 'default' : 'secondary'} onClick={() => setRange('today')}>{COST_TEXT.today}</Button>
        <Button size="sm" variant={range === 'week' ? 'default' : 'secondary'} onClick={() => setRange('week')}>{COST_TEXT.week}</Button>
      </div>
      <p className="text-xs opacity-70">{COST_TEXT.intro}</p>
      {failed ? <p className="text-xs opacity-70">{COST_TEXT.unavailable}</p> : null}
      {!data && !failed ? <p className="text-xs opacity-70">{COST_TEXT.loading}</p> : null}
      {data && s ? (
        <div className="flex flex-col gap-2">
          <dl className="grid grid-cols-4 gap-2 text-xs">
            <div><dt className="opacity-70">{COST_TEXT.spend}</dt><dd data-testid="cost-total" className="text-base font-semibold">{formatUsd(s.costMicros)}</dd></div>
            <div><dt className="opacity-70">{COST_TEXT.responses}</dt><dd>{s.byModel.reduce((n, g) => n + g.responses, 0)}</dd></div>
            <div><dt className="opacity-70">{COST_TEXT.cacheHit}</dt><dd data-testid="cost-cache">{s.cacheHitRate === null ? '—' : `${Math.round(s.cacheHitRate * 100)}%`}</dd></div>
            <div><dt className="opacity-70">{COST_TEXT.prefixReuse}</dt><dd data-testid="cost-prefix">{COST_TEXT.prefixValue(data.prefix?.reuseRate ?? null, data.prefix?.prefixes ?? 0)}</dd></div>
          </dl>
          {s.unpriced > 0 ? <p className="text-xs opacity-70">{COST_TEXT.unpriced(s.unpriced)}</p> : null}
          <div className="grid grid-cols-2 gap-3">
            <Groups title={COST_TEXT.byWorkspace} rows={s.byWorkspace} name={(k) => label(data, 'workspace', k)} />
            <Groups title={COST_TEXT.topSpenders} rows={s.byNode} name={(k) => label(data, 'node', k)} />
            <Groups title={COST_TEXT.byRoutine} rows={s.byRoutine} name={(k) => k} />
            <Groups title={COST_TEXT.byModel} rows={s.byModel} name={(k) => k || COST_TEXT.central} />
          </div>
          <div>
            <h4 className="text-xs font-semibold">{COST_TEXT.caps}</h4>
            <ul className="text-xs">
              {data.caps.map((c) => (
                <li key={c.scope} data-scope={c.scope} className="flex items-center gap-2">
                  <span>{c.scope}</span>
                  <span>{formatUsd(c.spentMicros)}{c.limitMicros > 0 ? ` / ${formatUsd(c.limitMicros)}` : ''}</span>
                  {c.pausedAt !== null ? (
                    <>
                      <Badge variant="destructive" title={c.reason ?? undefined}>{COST_TEXT.paused}</Badge>
                      <Button size="sm" variant="secondary" onClick={() => write('POST', `${COST_API_PATH}/resume`, { scope: c.scope })}>{COST_TEXT.resume}</Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center gap-2 text-xs">
              <label htmlFor="cost-day-cap">{COST_TEXT.dayCap}</label>
              <span className="w-40">
                <SettingsCombobox id="cost-day-cap" fieldId={COST_CAP_FIELD_ID} presets={COST_CAP_PRESETS} placeholder="No limit"
                  value={day && day.limitMicros > 0 ? String(day.limitMicros / 1e6) : ''} validate={validateDollars}
                  onCommit={(v) => write('PUT', `${COST_API_PATH}/caps`, { scope: 'day', limitMicros: dollarsToMicros(v) ?? 0 })} />
              </span>
            </div>
          </div>
          <p className="text-[11px] opacity-60">{COST_TEXT.pricing} <a href={data.pricing.source} target="_blank" rel="noreferrer" className="underline">{data.pricing.source}</a> ({data.pricing.checkedAt})</p>
        </div>
      ) : null}
    </section>
  )
}
