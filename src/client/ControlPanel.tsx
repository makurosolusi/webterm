// Settings › Developer table (F0-c read model, F1-f writes): every behaviour knob with effective value, source,
// reason and an editor (ControlPanelField) or the page that owns it, grouped by subsystem. Imitates the VS Code
// Settings editor (colored bar left of modified rows, code.visualstudio.com/docs/configure/settings). By default
// only the rows edited here (`ui === CONTROL_WHERE`) show; "Show everything" adds managed, derived and bootstrap rows.
// Also home of the shared fetch helpers the Health, Spending and Doctor pieces use.
import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CONTROL_WHERE } from '../shared/envSettings.contract'
import { CONTROL_TEXT, SOURCE_LABEL } from './controlPanelLabels'
import { ControlField } from './ControlPanelField'
import { matchesSearch, normalizeQuery } from './SettingsFields'

export const CONTROL_EFFECTIVE_PATH = '/api/control/effective'
export const CONTROL_DOCTOR_PATH = '/api/control/doctor'
export const AGENT_PROTECTION_PATH = '/api/agents/protection'

/** Mirror of the server `EffectiveRow` (src/server/effectiveConfig.ts); only the fields rendered here. */
export interface EffectiveRow {
  key: string; label: string; description: string; subsystem: string; value: string; secret: boolean; set?: boolean
  source: string; reason: string; modified: boolean; ui: string | null; mock?: true
  kind: string; editable: boolean; lockReason?: string; restart: 'none' | 'hot' | 'boot'; setting: string; default?: string
  pendingRestart: boolean; options?: string[]; optionLabels?: Record<string, string>; min?: number; max?: number; dangerNote?: string
}
export interface EffectiveConfig { mock: { active: boolean; keys: string[] }; rows: EffectiveRow[] }
export interface AgentProtection { kind: string; level: string; reasons: string[] }

/** Call `/api/control/effective` (GET read model, PUT settings write) or `path` (the Doctor's own). Throws with the server reason. */
export async function controlRequest(method: string, body?: unknown, query = '', path = CONTROL_EFFECTIVE_PATH): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path + query, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const e = (out ?? {}) as { error?: string; reason?: string }
    throw new Error(e.reason ?? e.error ?? `${method} ${path} failed (${res.status})`)
  }
  return out
}

/** GET `path` as JSON; throws on a non-2xx answer. */
export async function getJson(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const res = await fetch(path, { headers })
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`)
  return res.json()
}

export const isConfig = (v: unknown): v is EffectiveConfig =>
  !!v && typeof v === 'object' && Array.isArray((v as EffectiveConfig).rows) && typeof (v as EffectiveConfig).mock === 'object'
export const isProtection = (v: unknown): v is AgentProtection[] =>
  Array.isArray(v) && v.every((p) => p && typeof p.kind === 'string' && typeof p.level === 'string' && Array.isArray(p.reasons))

function valueText(r: EffectiveRow): string {
  if (r.secret) return r.set ? CONTROL_TEXT.secretSet : CONTROL_TEXT.secretUnset
  return r.value === '' ? '—' : r.value
}

/** Developer table, filtered by its own filter box. */
export function ControlPanel(): React.JSX.Element {
  const [data, setData] = useState<EffectiveConfig | null>(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let live = true
    controlRequest('GET')
      .then((v) => { if (!live) return; if (isConfig(v)) setData(v); else setFailed(true) })
      .catch(() => { if (live) setFailed(true) }) // shown as the loadFailed alert
    return () => { live = false }
  }, [])

  const write = async (key: string, value: string | null): Promise<string | null> => {
    try {
      const next = await controlRequest('PUT', value === null ? { set: {}, unset: [key] } : { set: { [key]: value }, unset: [] })
      if (isConfig(next)) setData(next)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  const q = normalizeQuery(filter)
  const rows = useMemo(() => (data?.rows ?? []).filter((r) =>
    (showAll || r.ui === CONTROL_WHERE) &&
    matchesSearch(`${r.key} ${r.label} ${r.description} ${r.subsystem} ${r.reason} ${r.ui ?? CONTROL_TEXT.noUi} ${SOURCE_LABEL[r.source] ?? r.source}`, q),
  ), [data, showAll, q])
  const groups = useMemo(() => {
    const m = new Map<string, EffectiveRow[]>()
    for (const r of rows) m.set(r.subsystem, [...(m.get(r.subsystem) ?? []), r])
    return [...m.entries()]
  }, [rows])

  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="control-panel">
      <p className="opacity-80">{CONTROL_TEXT.intro}</p>

      <div className="flex flex-wrap items-center gap-3">
        <Input type="search" aria-label={CONTROL_TEXT.search} placeholder={CONTROL_TEXT.search} value={filter}
          onChange={(e) => setFilter(e.target.value)} className="min-w-48 flex-1" />
        <label htmlFor="ctl-show-all" className="flex items-center gap-1" title={CONTROL_TEXT.showAllHint}>
          <Switch id="ctl-show-all" checked={showAll} onCheckedChange={setShowAll} />{CONTROL_TEXT.showAll}
        </label>
        {data ? <span role="status" className="text-xs opacity-70">{CONTROL_TEXT.count(rows.length, data.rows.length)}</span> : null}
      </div>

      {failed ? <p role="alert" className="text-xs text-destructive">{CONTROL_TEXT.loadFailed}</p> : null}
      {!data && !failed ? <p role="status" className="text-xs opacity-70">{CONTROL_TEXT.loading}</p> : null}
      {data && rows.length === 0 ? <p className="text-xs opacity-70">{CONTROL_TEXT.empty}</p> : null}

      {groups.map(([subsystem, list]) => (
        <section key={subsystem} aria-label={subsystem}>
          <h3 className="font-semibold">{subsystem}</h3>
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="text-left opacity-70">
                <th className="w-[22%]">{CONTROL_TEXT.colKey}</th><th className="w-[12%]">{CONTROL_TEXT.colValue}</th>
                <th className="w-[10%]">{CONTROL_TEXT.colSource}</th><th>{CONTROL_TEXT.colReason}</th>
                <th className="w-[30%]">{CONTROL_TEXT.colUi}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.key} data-key={r.key} data-modified={r.modified || undefined} className="align-top">
                  <td className={'border-l-2 pl-2 ' + (r.modified ? 'border-l-sky-500' : 'border-l-transparent')}
                    title={r.modified ? CONTROL_TEXT.modifiedMark : undefined}>
                    <div>{r.label}</div>
                    <code className="break-all text-[11px] opacity-70">{r.key}</code>
                  </td>
                  <td className="break-all">
                    {r.mock ? <Badge variant="destructive" className="mr-1 bg-red-600 font-bold">{CONTROL_TEXT.mockBadge}</Badge> : null}
                    {valueText(r)}
                  </td>
                  <td>{SOURCE_LABEL[r.source] ?? r.source}</td>
                  <td>{r.reason}</td>
                  <td><ControlField row={r} write={write} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
