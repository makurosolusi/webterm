// Settings › Control (F0-c read model, F1-f writes): every behaviour knob with effective value, source, reason
// and an editor (ControlPanelField) or the card that owns it, grouped by subsystem, plus the Doctor. Imitates the VS Code Settings editor: a colored bar left of modified rows
// and a "Modified" filter (VS Code `@modified`, code.visualstudio.com/docs/configure/settings), plus an
// "env-only" filter so hidden knobs are one click away. A red MOCK badge shows whenever a runtime is simulated.
import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { TOKEN_HEADER } from './api'
import { CONTROL_TEXT, SOURCE_LABEL } from './controlPanelLabels'
import { ControlField } from './ControlPanelField'
import { ControlPanelDoctor } from './ControlPanelDoctor'
import { CostPanel } from './CostPanel'
import { PolicyRules } from './PolicyRules'
import { AgentMemory } from './AgentMemory'
import { SecretsPanel } from './SecretsPanel'
import { RoutinesPanel } from './RoutinesPanel'
import { matchesSearch, normalizeQuery } from './SettingsFields'
import { peekToken } from './transportToken'

export const CONTROL_EFFECTIVE_PATH = '/api/control/effective'
export const CONTROL_DOCTOR_PATH = '/api/control/doctor'
export const AGENT_PROTECTION_PATH = '/api/agents/protection'

/** Mirror of the server `EffectiveRow` (src/server/effectiveConfig.ts); only the fields rendered here. */
export interface EffectiveRow {
  key: string; label: string; description: string; subsystem: string; value: string; secret: boolean; set?: boolean
  source: string; reason: string; modified: boolean; ui: string | null; envOnly: boolean; mock?: true
  kind: string; editable: boolean; lockReason?: string; restart: 'none' | 'hot' | 'boot'; setting: string; default?: string
  pendingRestart: boolean; options?: string[]; optionLabels?: Record<string, string>; min?: number; max?: number; dangerNote?: string
}
export interface EffectiveConfig { mock: { active: boolean; keys: string[] }; rows: EffectiveRow[] }
export interface AgentProtection { kind: string; level: string; reasons: string[] }

/** Call `/api/control/effective` (GET read model, PUT settings write) or `path` (the Doctor's own). Throws with the server reason. */
export async function controlRequest(method: string, body?: unknown, query = '', path = CONTROL_EFFECTIVE_PATH): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(path + query, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const out: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const e = (out ?? {}) as { error?: string; reason?: string }
    throw new Error(e.reason ?? e.error ?? `${method} ${path} failed (${res.status})`)
  }
  return out
}

async function getJson(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const t = peekToken()
  if (t !== '') headers[TOKEN_HEADER] = t
  const res = await fetch(path, { headers })
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`)
  return res.json()
}

const isConfig = (v: unknown): v is EffectiveConfig =>
  !!v && typeof v === 'object' && Array.isArray((v as EffectiveConfig).rows) && typeof (v as EffectiveConfig).mock === 'object'
const isProtection = (v: unknown): v is AgentProtection[] =>
  Array.isArray(v) && v.every((p) => p && typeof p.kind === 'string' && typeof p.level === 'string' && Array.isArray(p.reasons))

function valueText(r: EffectiveRow): string {
  if (r.secret) return r.set ? CONTROL_TEXT.secretSet : CONTROL_TEXT.secretUnset
  return r.value === '' ? '—' : r.value
}

/** Control tab body; `query` is the Settings search box (already normalized). */
export function ControlPanel({ query = '' }: { query?: string }): React.JSX.Element {
  const [data, setData] = useState<EffectiveConfig | null>(null)
  const [failed, setFailed] = useState(false)
  // undefined = loading, null = endpoint absent or unreadable (rendered as "not available yet").
  const [protection, setProtection] = useState<AgentProtection[] | null | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [envOnly, setEnvOnly] = useState(false)
  const [modifiedOnly, setModifiedOnly] = useState(false)

  useEffect(() => {
    let live = true
    controlRequest('GET')
      .then((v) => { if (!live) return; if (isConfig(v)) setData(v); else setFailed(true) })
      .catch(() => { if (live) setFailed(true) }) // shown as the loadFailed alert
    getJson(AGENT_PROTECTION_PATH)
      .then((v) => { if (live) setProtection(isProtection(v) ? v : null) })
      .catch(() => { if (live) setProtection(null) }) // endpoint not built yet (wkr-sec-51): degrade, do not fail
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

  const q = normalizeQuery(`${query} ${filter}`)
  const rows = useMemo(() => (data?.rows ?? []).filter((r) =>
    (!envOnly || r.envOnly) && (!modifiedOnly || r.modified) &&
    matchesSearch(`${r.key} ${r.label} ${r.description} ${r.subsystem} ${r.reason} ${r.ui ?? CONTROL_TEXT.noUi} ${SOURCE_LABEL[r.source] ?? r.source}`, q),
  ), [data, envOnly, modifiedOnly, q])
  const groups = useMemo(() => {
    const m = new Map<string, EffectiveRow[]>()
    for (const r of rows) m.set(r.subsystem, [...(m.get(r.subsystem) ?? []), r])
    return [...m.entries()]
  }, [rows])

  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="control-panel">
      <p className="opacity-80">{CONTROL_TEXT.intro}</p>
      {data?.mock.active ? (
        <p role="alert" title={CONTROL_TEXT.mockTitle} className="flex items-center gap-2">
          <Badge variant="destructive" className="bg-red-600 font-bold">{CONTROL_TEXT.mockBadge}</Badge>
          <span>{CONTROL_TEXT.mockTitle} ({data.mock.keys.join(', ')})</span>
        </p>
      ) : null}

      <section aria-label={CONTROL_TEXT.protectionTitle}>
        <h3 className="font-semibold">{CONTROL_TEXT.protectionTitle}</h3>
        {protection === null ? <p className="text-xs opacity-70">{CONTROL_TEXT.protectionMissing}</p> : null}
        {protection ? (
          <ul className="text-xs">
            {protection.map((p) => (
              <li key={p.kind} data-level={p.level}>
                <strong>{p.kind}</strong>: {CONTROL_TEXT.protectionLevel[p.level] ?? p.level}
                {p.reasons.length > 0 ? ` — ${p.reasons.join('; ')}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <ControlPanelDoctor />

      <CostPanel />

      <PolicyRules />

      <AgentMemory />
      <SecretsPanel />
      <RoutinesPanel />

      <div className="flex flex-wrap items-center gap-3">
        <Input type="search" aria-label={CONTROL_TEXT.search} placeholder={CONTROL_TEXT.search} value={filter}
          onChange={(e) => setFilter(e.target.value)} className="min-w-48 flex-1" />
        <label htmlFor="ctl-env-only" className="flex items-center gap-1">
          <Checkbox id="ctl-env-only" checked={envOnly} onCheckedChange={(v) => setEnvOnly(v === true)} />{CONTROL_TEXT.envOnly}
        </label>
        <label htmlFor="ctl-modified" className="flex items-center gap-1">
          <Checkbox id="ctl-modified" checked={modifiedOnly} onCheckedChange={(v) => setModifiedOnly(v === true)} />{CONTROL_TEXT.modifiedOnly}
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
                    <code className="break-all">{r.key}</code>
                    <div className="opacity-70">{r.label}</div>
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
