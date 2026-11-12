// Abilities tab: every tool Central has (`GET /api/central/tools`) plus the approved skills it can load.
// Read-only, like GitHub app permissions or Claude Code `/permissions`: one summary line, the exceptions
// (asks you first, not allowed) on top with a badge, the default (runs on its own) last and unbadged,
// each kind split into collapsible categories. What a tool may do is decided by the level, set in
// Settings › Central Agent; "Change" opens that exact field.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { InfoHint } from '../AgentMemoryBoard'
import { openSettingsSection } from '../settings.link'
import { InboxApiError } from '../inboxTypes'
import { AB, CL, LEVEL_MEANING, LEVEL_NAMES } from './centralLabels'
import { SKILLS_OFF, centralControlApi } from './centralControlApi'
import type { CentralControlClient, ToolAccess, ToolGroup, ToolRow, ToolsView } from './centralControlTypes'
import { useLoad } from './centralLoad'
import { openCentralSettings } from './LevelPanel'
import { toolLabel } from './toolLabels'

/** Settings section with the allow / ask / deny rules. */
export const RULES_SETTINGS_SECTION = 'rules'
const openRules = (): void => openSettingsSection(RULES_SETTINGS_SECTION)

const TEXT = {
  about: 'About abilities',
  search: 'Search abilities',
  /** [one, many] */
  short: { asks: ['asks first', 'ask first'], blocked: ['not allowed', 'not allowed'], auto: ['on its own', 'on their own'] },
  kind: { asks: 'Asks you first', blocked: 'Not allowed', auto: 'Runs on its own' },
  defaults: 'Tools without a badge run on their own. Open a row for its full description and internal name.',
} as const

/** Above this many "runs on its own" tools their categories start collapsed, so the exceptions stay in view. */
const AUTO_OPEN_MAX = 15

/** With Central fully off every /api/central path is 404: that is the off state, not an error. */
const CENTRAL_OFF: ToolsView = { level: 'off', tools: [] }
const toolsOrOff = (client: CentralControlClient, signal: AbortSignal): Promise<ToolsView> =>
  client.listTools(signal).catch((err: unknown) => { if (err instanceof InboxApiError && err.status === 404) return CENTRAL_OFF; throw err })

/** Permission kinds in display order: exceptions first. "Not allowed" also covers tools turned off: neither will run. */
type Kind = keyof typeof TEXT.kind
const KINDS: readonly Kind[] = ['asks', 'blocked', 'auto']
const kindOf = (a: ToolAccess): Kind => (a === 'off' ? 'blocked' : a)
const GROUP_ORDER = Object.keys(AB.group) as ToolGroup[]

/** "L3 Starts workers, …" -> "Level 3 — starts workers, …". */
export const levelText = (name: string): string => name.replace(/^L(\d) (.)/, (_, n: string, c: string) => `Level ${n} — ${c.toLowerCase()}`)

/** "62 on their own · 9 ask first"; kinds with no tool are left out, exceptions first. */
export function accessCounts(tools: readonly ToolRow[]): string {
  return KINDS.map((k) => [k, tools.filter((t) => kindOf(t.access) === k).length] as const)
    .filter(([, n]) => n > 0).map(([k, n]) => `${n} ${TEXT.short[k][n === 1 ? 0 : 1]}`).join(' · ')
}

const searchable = (t: ToolRow): string => { const l = toolLabel(t.name, t.summary); return `${l.title} ${l.text} ${t.name}`.toLowerCase() }

function ToolItem({ t }: { t: ToolRow }) {
  const label = toolLabel(t.name, t.summary)
  return (
    <li className="ccp-ab-item" data-access={t.access}>
      <details className="ccp-ab-row">
        <summary>
          <strong className="ccp-ab-row__title">{label.title}</strong>
          {t.access !== 'auto' && <span className="ccp-badge ccp-badge--warn">{AB.badge[t.access]}</span>}
          <span className="ccp-ab-row__text">{label.text}</span>
        </summary>
        <div className="ccp-ab-row__more">{label.text} <code className="ccp-row__meta">{t.name}</code></div>
      </details>
    </li>
  )
}

function ActiveSkills({ client }: { client: CentralControlClient }) {
  const skills = useLoad((s) => client.listActiveSkills(s))
  const off = skills.code === SKILLS_OFF
  return (
    <>
      <h3 id="ccp-ab-skills-h">{AB.skillsHeading}</h3>
      {off && <p>{AB.skillsOff}</p>}
      {skills.error && !off && <p role="alert" className="ccp-error">{skills.error}</p>}
      {skills.loading && !skills.data && <p role="status">{CL.loading}</p>}
      {skills.data?.length === 0 && <p>{AB.skillsNone}</p>}
      {!!skills.data?.length && (
        <ul className="ccp-list" aria-labelledby="ccp-ab-skills-h">
          {skills.data.map((s) => <li key={s.name} className="ccp-row"><span className="ccp-row__main"><strong>{s.name}</strong> {s.description}</span></li>)}
        </ul>
      )}
    </>
  )
}

/** One permission kind ("Asks you first (9)") split into collapsible categories. */
function KindGroup({ kind, rows, open }: { kind: Kind; rows: readonly ToolRow[]; open: boolean }) {
  return (
    <div role="group" aria-label={TEXT.kind[kind]} data-kind={kind}>
      <h4 className="ccp-group-h">{TEXT.kind[kind]} ({rows.length})</h4>
      {GROUP_ORDER.map((g) => {
        const inGroup = rows.filter((t) => t.group === g)
        if (inGroup.length === 0) return null
        return (
          <details key={g} className="ccp-ab-cat" open={open}>
            <summary>{AB.group[g]} ({inGroup.length})</summary>
            <ul className="ccp-list">{inGroup.map((t) => <ToolItem key={t.name} t={t} />)}</ul>
          </details>
        )
      })}
    </div>
  )
}

export default function AbilitiesView({ client = centralControlApi }: { client?: CentralControlClient }) {
  const tools = useLoad((s) => toolsOrOff(client, s))
  const [query, setQuery] = useState('')
  const data = tools.data
  const q = query.trim().toLowerCase()
  const all = data?.tools ?? []
  const shown = q ? all.filter((t) => searchable(t).includes(q)) : all
  const autoTotal = all.filter((t) => t.access === 'auto').length
  return (
    <section className="ccp-section" aria-labelledby="ccp-ab-h">
      <h3 id="ccp-ab-h">{CL.tabAbilities}</h3>
      {tools.error && (
        <div className="ccp-off">
          <p role="alert" className="ccp-error">{tools.error}</p>
          <Button type="button" size="sm" variant="secondary" onClick={tools.reload}>{CL.refresh}</Button>
        </div>
      )}
      {tools.loading && !data && <p role="status">{CL.loading}</p>}
      {data && (
        <>
          <div className="ccp-ab-summary">
            <span data-testid="ability-summary">{[levelText(LEVEL_NAMES[data.level] ?? data.level), accessCounts(all)].filter(Boolean).join(' · ')}</span>
            <Button type="button" size="xs" variant="link" aria-label={CL.changeLabel} onClick={() => openCentralSettings('level')}>{CL.change}</Button>
            <InfoHint label={TEXT.about}><p>{AB.intro}</p><p>{LEVEL_MEANING[data.level]}</p><p>{TEXT.defaults}</p></InfoHint>
          </div>
          {data.level === 'off' && <p data-central-off="level">{AB.levelOff}</p>}
          {all.length === 0 ? (data.level !== 'off' && <p>{AB.noTools}</p>) : (
            <>
              <div className="ccp-ab-search">
                <Input type="search" aria-label={TEXT.search} placeholder={TEXT.search} value={query} onChange={(e) => setQuery(e.target.value)} />
                <span className="ccp-row__meta" data-testid="ability-count" aria-live="polite">
                  {q ? `${shown.length} of ${all.length}` : `${all.length} ${all.length === 1 ? 'ability' : 'abilities'}`}
                </span>
              </div>
              {shown.length === 0 && <p>{AB.none}</p>}
              {KINDS.map((k) => {
                const rows = shown.filter((t) => kindOf(t.access) === k)
                return rows.length > 0 && <KindGroup key={k} kind={k} rows={rows} open={!!q || k !== 'auto' || autoTotal <= AUTO_OPEN_MAX} />
              })}
              <p className="ccp-row__meta ccp-footnote">{AB.footnote} <Button type="button" size="xs" variant="link" onClick={openRules}>{AB.openRules}</Button></p>
            </>
          )}
        </>
      )}
      {data && data !== CENTRAL_OFF && <ActiveSkills client={client} />}
    </section>
  )
}
