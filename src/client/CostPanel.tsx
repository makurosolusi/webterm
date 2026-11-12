// Spending report (Control › Spending, F4-e; moved out of Settings in the settings overhaul): what Claude Code
// agents and Central spent today / over 7 days by workspace, agent, routine and model, and which limits paused work.
// The one daily limit is Central's (Settings › Central, data-field central.costLimit); the old separate "Pause all
// work at $" cap is gone (merged at boot, server cost/costDayCap.ts). Cache and prefix numbers are `CostDetails`,
// shown in Settings › Developer. Numbers come from GET /api/cost (cost.route.ts); prices are estimates, not a bill.
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { openSettingsAt } from './settings.link'
import { Segmented } from './centralSettings.controls'
import { controlRequest } from './ControlPanel'
import type { CostResponse } from '../server/cost/cost.route'
import type { SpendGroup, SpendSummary } from '../server/cost/costStore'

export const COST_API_PATH = '/api/cost'

export const COST_TEXT = {
  /** Region name only: the Control › Spending tab already says it, so no visible heading here. */
  title: 'Spending',
  intro: 'Estimated spend of Claude Code agents and the Central Agent, from their own usage data. Not a bill.',
  period: 'Period',
  today: 'Today',
  week: '7 days',
  unavailable: 'Spending data is unavailable (the cost ledger is off).',
  loading: 'Loading spending…',
  spend: 'Spent',
  responses: 'Responses',
  details: 'Spending details (7 days)',
  cacheHit: 'Cache hit rate',
  prefixReuse: 'Central Agent prefix reuse (7 days)',
  prefixValue: (rate: number | null, n: number) => (rate === null ? '—' : `${Math.round(rate * 100)}% of ${n} prefix${n === 1 ? '' : 'es'}`),
  unpriced: (n: number) => `${n} responses from models without a price are not counted.`,
  byWorkspace: 'By workspace',
  topSpenders: 'Top spenders',
  byRoutine: 'By routine or plan',
  byModel: 'By model',
  central: 'Central Agent',
  none: 'Nothing yet.',
  caps: 'Limits',
  limitLine: 'One daily spending limit covers Central, routines, plans and bake-offs.',
  limitLink: 'Change the daily limit',
  writeFailed: (why: string) => `Could not resume: ${why}`,
  resume: 'Resume',
  paused: 'Paused',
  pricing: 'Prices from',
} as const

const KIND_NAME: Record<string, string> = { day: 'All work today', routine: 'Routine', dag: 'Plan', bakeoff: 'Bake-off', central: COST_TEXT.central }
/** Plain name for a cap scope or routine key: `routine:x` -> "Routine x", `day` -> "All work today". */
export function scopeName(scope: string): string {
  if (scope === '') return COST_TEXT.central
  const i = scope.indexOf(':')
  const kind = i < 0 ? scope : scope.slice(0, i)
  const ref = i < 0 ? '' : scope.slice(i + 1)
  const name = KIND_NAME[kind]
  if (!name) return scope
  return ref ? `${name} ${ref}` : name
}

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

/** GET /api/cost; `error` = why it failed, in the server's words. */
function useCost(): { data: CostResponse | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<CostResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    controlRequest('GET', undefined, '', COST_API_PATH)
      .then((v) => { if (isCost(v)) { setData(v); setError(null) } else setError(COST_TEXT.unavailable) })
      .catch(() => setError(COST_TEXT.unavailable)) // ledger off or older server
  }, [])
  useEffect(reload, [reload])
  return { data, error, reload }
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function CostPanel(): React.JSX.Element {
  const { data, error: loadError, reload } = useCost()
  const [writeError, setWriteError] = useState<string | null>(null)
  const [range, setRange] = useState<'today' | 'week'>('today')

  // A failed Resume says what went wrong; the report itself stays on screen.
  const resume = (scope: string): void => {
    setWriteError(null)
    controlRequest('POST', { scope }, '', `${COST_API_PATH}/resume`).then(reload, (err: unknown) => setWriteError(COST_TEXT.writeFailed(why(err))))
  }

  const s: SpendSummary | undefined = data?.[range]
  return (
    <section aria-label={COST_TEXT.title} data-testid="cost-panel">
      <div className="flex items-center gap-2">
        <Segmented label={COST_TEXT.period} value={range} onChange={(v) => setRange(v === 'week' ? 'week' : 'today')}
          options={[{ value: 'today', label: COST_TEXT.today }, { value: 'week', label: COST_TEXT.week }]} />
      </div>
      <p className="text-xs opacity-70">{COST_TEXT.intro}</p>
      {loadError ? <p className="text-xs opacity-70">{loadError}</p> : null}
      {!data && !loadError ? <p className="text-xs opacity-70">{COST_TEXT.loading}</p> : null}
      {data && s ? (
        <div className="flex flex-col gap-2">
          <dl className="flex items-end gap-6 text-xs">
            <div><dt className="opacity-70">{COST_TEXT.spend}</dt><dd data-testid="cost-total" className="text-2xl font-semibold">{formatUsd(s.costMicros)}</dd></div>
            <div><dt className="opacity-70">{COST_TEXT.responses}</dt><dd>{s.byModel.reduce((n, g) => n + g.responses, 0)}</dd></div>
          </dl>
          <div className="grid grid-cols-2 gap-3">
            <Groups title={COST_TEXT.byWorkspace} rows={s.byWorkspace} name={(k) => label(data, 'workspace', k)} />
            <Groups title={COST_TEXT.topSpenders} rows={s.byNode} name={(k) => label(data, 'node', k)} />
            <Groups title={COST_TEXT.byRoutine} rows={s.byRoutine} name={scopeName} />
            <Groups title={COST_TEXT.byModel} rows={s.byModel} name={(k) => k || COST_TEXT.central} />
          </div>
          <div>
            <h4 className="text-xs font-semibold">{COST_TEXT.caps}</h4>
            <ul className="text-xs">
              {data.caps.map((c) => (
                <li key={c.scope} data-scope={c.scope} className="flex items-center gap-2">
                  <span>{scopeName(c.scope)}</span>
                  <span>{formatUsd(c.spentMicros)}{c.limitMicros > 0 ? ` / ${formatUsd(c.limitMicros)}` : ''}</span>
                  {c.pausedAt !== null ? (
                    <>
                      <Badge variant="destructive" title={c.reason ?? undefined}>{COST_TEXT.paused}</Badge>
                      <Button size="sm" variant="secondary" onClick={() => resume(c.scope)}>{COST_TEXT.resume}</Button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
              <span className="opacity-70">{COST_TEXT.limitLine}</span>
              <Button size="sm" variant="link" className="h-auto p-0" onClick={() => openSettingsAt('central', 'central.costLimit')}>{COST_TEXT.limitLink}</Button>
            </p>
            {writeError ? <p role="alert" className="text-xs text-destructive">{writeError}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** Settings › Developer: cache hit rate, Central prefix reuse, unpriced responses and the price source (7 days). */
export function CostDetails(): React.JSX.Element {
  const { data, error } = useCost()
  const s = data?.week
  return (
    <section aria-label={COST_TEXT.details} data-testid="cost-details" className="text-xs">
      <h4 className="font-semibold">{COST_TEXT.details}</h4>
      {error ? <p className="opacity-70">{error}</p> : null}
      {!data && !error ? <p className="opacity-70">{COST_TEXT.loading}</p> : null}
      {data && s ? (
        <>
          <dl className="mt-1 grid grid-cols-2 gap-2">
            <div><dt className="opacity-70">{COST_TEXT.cacheHit}</dt><dd data-testid="cost-cache">{s.cacheHitRate === null ? '—' : `${Math.round(s.cacheHitRate * 100)}%`}</dd></div>
            <div><dt className="opacity-70">{COST_TEXT.prefixReuse}</dt><dd data-testid="cost-prefix">{COST_TEXT.prefixValue(data.prefix?.reuseRate ?? null, data.prefix?.prefixes ?? 0)}</dd></div>
          </dl>
          {s.unpriced > 0 ? <p className="opacity-70">{COST_TEXT.unpriced(s.unpriced)}</p> : null}
          <p className="text-[11px] opacity-60">{COST_TEXT.pricing} <a href={data.pricing.source} target="_blank" rel="noreferrer" className="underline">{data.pricing.source}</a> ({data.pricing.checkedAt})</p>
        </>
      ) : null}
    </section>
  )
}
