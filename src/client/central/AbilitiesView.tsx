// Abilities tab: every tool Central has, grouped, with what the current level lets it do (`GET /api/central/tools`),
// plus the approved skills it can load. Read-only, like VS Code's agent tools list but without per-tool switches:
// what a tool may do is decided by the level, set in Settings › Central Agent.
import { Button } from '@/components/ui/button'
import { useState } from 'react'
import { OPEN_SETTINGS_EVENT } from '../claudeLauncher/claudeLaunch.client'
import { InboxApiError } from '../inboxTypes'
import { Segmented } from '../centralSettings.controls'
import { AB, CL, LEVEL_NAMES } from './centralLabels'
import { SKILLS_OFF, centralControlApi } from './centralControlApi'
import type { CentralControlClient, ToolAccess, ToolGroup, ToolRow, ToolsView } from './centralControlTypes'
import { useLoad } from './centralLoad'
import { openCentralSettings } from './LevelPanel'
import { toolLabel } from './toolLabels'

/** Settings section with the allow / ask / deny rules. */
export const RULES_SETTINGS_SECTION = 'rules'
const openRules = (): void => { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section: RULES_SETTINGS_SECTION } })) }

/** With Central fully off every /api/central path is 404: that is the off state, not an error. */
const CENTRAL_OFF: ToolsView = { level: 'off', tools: [] }
const toolsOrOff = (client: CentralControlClient, signal: AbortSignal): Promise<ToolsView> =>
  client.listTools(signal).catch((err: unknown) => { if (err instanceof InboxApiError && err.status === 404) return CENTRAL_OFF; throw err })

type Filter = 'all' | 'auto' | 'asks' | 'blocked'
const ACCESS_ORDER: readonly ToolAccess[] = ['auto', 'asks', 'blocked', 'off']
const GROUP_ORDER = Object.keys(AB.group) as ToolGroup[]
const FILTERS = [{ value: 'all', label: AB.all }, ...(['auto', 'asks', 'blocked'] as const).map((v) => ({ value: v, label: AB.filterLabel[v] }))]

/** "Not allowed" also covers tools that are switched off: neither will run. */
const matches = (t: ToolRow, f: Filter): boolean => f === 'all' || t.access === f || (f === 'blocked' && t.access === 'off')

/** "2 run on their own · 1 ask you first"; kinds with no tool are left out. */
export function accessCounts(tools: readonly ToolRow[]): string {
  return ACCESS_ORDER.map((a) => [a, tools.filter((t) => t.access === a).length] as const)
    .filter(([, n]) => n > 0).map(([a, n]) => `${n} ${AB.count[a][n === 1 ? 0 : 1]}`).join(' · ')
}

function ToolItem({ t }: { t: ToolRow }) {
  const label = toolLabel(t.name, t.summary)
  return (
    <li className="ccp-row" data-access={t.access}>
      <span className="ccp-row__main"><strong>{label.title}</strong> <code className="ccp-row__meta">{t.name}</code><br />{label.text}</span>
      <span className={t.access === 'auto' ? 'ccp-badge' : 'ccp-badge ccp-badge--warn'}>{AB.badge[t.access]}</span>
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

export default function AbilitiesView({ client = centralControlApi }: { client?: CentralControlClient }) {
  const tools = useLoad((s) => toolsOrOff(client, s))
  const [filter, setFilter] = useState<Filter>('all')
  const data = tools.data
  const shown = data?.tools.filter((t) => matches(t, filter)) ?? []
  return (
    <section className="ccp-section" aria-labelledby="ccp-ab-h">
      <h3 id="ccp-ab-h">{CL.tabAbilities}</h3>
      <p>{AB.intro}</p>
      {tools.error && (
        <div className="ccp-off">
          <p role="alert" className="ccp-error">{tools.error}</p>
          <Button type="button" size="sm" variant="secondary" onClick={tools.reload}>{CL.refresh}</Button>
        </div>
      )}
      {tools.loading && !data && <p role="status">{CL.loading}</p>}
      {data && (
        <>
          <p className="ccp-row__meta" data-testid="ability-level">{LEVEL_NAMES[data.level] ?? data.level}</p>
          {data.level === 'off' && (
            <div className="ccp-off" data-central-off="level">
              <p>{AB.levelOff}</p>
              <Button type="button" size="sm" variant="secondary" aria-label={CL.changeLabel} onClick={openCentralSettings}>{CL.change}</Button>
            </div>
          )}
          {data.tools.length === 0 ? (data.level !== 'off' && <p>{AB.noTools}</p>) : (
            <>
              <p data-testid="ability-counts">{accessCounts(data.tools)}</p>
              <Segmented label={AB.filter} value={filter} options={FILTERS} onChange={(v) => setFilter(v as Filter)} />
              {shown.length === 0 && <p>{AB.none}</p>}
              {GROUP_ORDER.map((g) => {
                const rows = shown.filter((t) => t.group === g)
                if (rows.length === 0) return null
                return (
                  <div key={g} role="group" aria-label={AB.group[g]}>
                    <h4 className="ccp-group-h">{AB.group[g]} ({rows.length})</h4>
                    <ul className="ccp-list">{rows.map((t) => <ToolItem key={t.name} t={t} />)}</ul>
                  </div>
                )
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
