// Control > Skills: the library of CENTRAL skills only (rules Central follows): searchable rows, a detail under the
// row, and the review actions for rows that wait on a human. Skills for agents on the canvas live in the canvas
// sidebar Skills panel. Skills are written only by the author agent: "Write with an agent", no form types a skill.
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { useEffect, useState } from 'react'
import type { ChatClient } from '../chat/chatTypes'
import { openSideBarView } from '../sideBar/sideBar.open'
import CentralSkillAuthorButton from './CentralSkillAuthorButton'
import { CentralDraftsPanel } from './SkillAuthorDrafts'
import { CL } from './centralLabels'
import { SKILLS_OFF, centralControlApi } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { useLoad } from './centralLoad'
import { onCentralSkillAuthorActivity } from './centralSkillAuthor.events'
import SkillDetail from './SkillDetail'
import SkillRow from './SkillRow'
import './skillLibrary.css'
import SkillReviewList from './SkillReview'
import SkillsOff from './SkillsOff'
import { SKILL_FILTERS, type SkillFilter, countByFilter, matchesFilter, needsReview, searchRows } from './skillLibraryModel'
import { centralDraftsOf } from './skillAuthorModel'

const SKELETON_ROWS = [0, 1, 2]
const OPEN: readonly string[] = ['proposed', 'evaluated', 'pending_approval']
const keyOf = (r: SkillReviewRow): string => `${r.record.name}@${r.record.version}`

export default function SkillLibrary({ client = centralControlApi, chat }: { client?: CentralControlClient; /** Test seam for the chat API the Central skill author opens its conversation with. */ chat?: Pick<ChatClient, 'createConversation'> }) {
  const list = useLoad((s) => client.listSkills(s))
  // Owned here, not by the Drafts panel: the panel is mounted only while drafts exist, and the first draft Central proposes must still trigger a reload.
  const reload = list.reload
  useEffect(() => onCentralSkillAuthorActivity(reload), [reload])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SkillFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [draftsOpen, setDraftsOpen] = useState(true)
  const off = list.code === SKILLS_OFF
  // Canvas skills have their own home (the canvas Skills panel); this library never lists them.
  const rows = (list.data ?? []).filter((r) => r.record.audience === 'central')
  const searched = searchRows(rows, query)
  const counts = countByFilter(searched)
  const shown = searched.filter((r) => matchesFilter(r, filter))
  const drafts = centralDraftsOf(rows).length
  // Central's own drafts are reviewed in their Drafts panel, so the general review list does not repeat them.
  const inDrafts = new Set(centralDraftsOf(rows))
  const hasOpen = (d: SkillReviewRow): boolean => rows.some((r) => r.record.name === d.record.name && OPEN.includes(r.record.status))
  // "Ask the agent ..." of the open detail: a built-in is read only and only offers a variant; its name goes to the author as a read-only reference and the server only lets it propose a NEW name.
  const reviseOf = (d: SkillReviewRow) => {
    const { name, origin, status } = d.record
    const reason = status !== 'active' ? CL.skillReviseInactive : hasOpen(d) ? CL.skillEditOpenDraft : undefined
    if (origin === 'builtin') return <><small>{CL.skillVariantHint(name)}</small> <CentralSkillAuthorButton key={`variant:${keyOf(d)}`} target={name} label={CL.skillAuthorVariant} {...(chat ? { chat } : {})} /></>
    return <CentralSkillAuthorButton key={`author:${keyOf(d)}`} target={name} label={CL.skillAuthorRevise} {...(reason ? { disabledReason: reason } : {})} {...(chat ? { chat } : {})} />
  }
  const rest = rows.filter((r) => needsReview(r) && !inDrafts.has(r))
  const clear = (): void => { setQuery(''); setFilter('all') }
  const detailOf = (r: SkillReviewRow) => (close: () => void) => <SkillDetail key={`${keyOf(r)}:${r.record.enabled}`} row={r} client={client} onClose={close} onChanged={list.reload} revise={reviseOf(r)} />
  return (
    <section className="ccp-section ccp-skills" aria-labelledby="ccp-skills-h" aria-busy={list.loading && !list.data ? true : undefined}>
      <h3 id="ccp-skills-h">{CL.skillsLibraryHeading}</h3>
      {!off && (
        <IconButton label={CL.skillsRefresh} size="icon-sm" disabled={list.loading} onClick={list.reload}>
          <span className={`codicon codicon-refresh${list.loading ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />
        </IconButton>
      )}
      <p className="ccp-skill-empty">{CL.skillsPurpose}</p>
      <p className="ccp-skill-empty">{CL.skillsCanvasPointer} <Button type="button" size="xs" variant="link" onClick={() => openSideBarView('skills')}>{CL.skillsOpenCanvas}</Button></p>
      {off && <SkillsOff onEnabled={list.reload} />}
      {list.error && !off && (
        <div><p role="alert" className="ccp-error">{list.error}</p><Button type="button" size="sm" variant="secondary" onClick={list.reload}>{CL.skillsRetry}</Button></div>
      )}
      {list.loading && !list.data && (
        <div><span role="status" className="sr-only">{CL.loading}</span>{SKELETON_ROWS.map((i) => <div key={i} className="ccp-skill-skel" aria-hidden="true" />)}</div>
      )}
      {list.data && rows.length === 0 && <p className="ccp-skill-empty">{CL.skillsEmpty}</p>}
      {!off && list.data && (
        <>
          <div className="ccp-skill-section__actions">
            {drafts > 0 && <Button type="button" size="sm" variant="ghost" aria-expanded={draftsOpen} onClick={() => setDraftsOpen(!draftsOpen)}>{CL.skillDraftsBadge(drafts)}</Button>}
            <CentralSkillAuthorButton label={CL.skillAuthorWrite} {...(chat ? { chat } : {})} />
          </div>
          {rows.length > 0 && (
            <div className="ccp-skill-toolbar">
              <Input type="search" value={query} aria-label={CL.skillsSearch} placeholder={CL.skillsSearch} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
              <div className="ccp-skill-seg" role="group" aria-label={CL.skillsFilterLabel}>
                {SKILL_FILTERS.map((f) => (
                  <Button key={f} type="button" size="sm" variant={filter === f ? 'secondary' : 'ghost'} aria-pressed={filter === f} onClick={() => setFilter(f)}>{CL.skillsFilter[f]}<small>{counts[f]}</small></Button>
                ))}
              </div>
            </div>
          )}
          {rows.length > 0 && shown.length === 0 && (
            <p className="ccp-skill-empty">{CL.skillsNoMatchFor(query.trim() || CL.skillsFilter[filter])} <Button type="button" size="xs" variant="link" onClick={clear}>{CL.skillsClear}</Button></p>
          )}
          {drafts > 0 && draftsOpen && <CentralDraftsPanel list={list} client={client} />}
          <ul aria-label={CL.skillsLibraryHeading} className="ccp-skill-list">
            {shown.map((r) => <SkillRow key={keyOf(r)} row={r} client={client} open={keyOf(r) === selected} onToggle={() => setSelected(keyOf(r) === selected ? null : keyOf(r))} onChanged={list.reload} detail={detailOf(r)} />)}
          </ul>
          {rest.length > 0 && (
            <section className="ccp-skill-review" aria-labelledby="ccp-skills-review-h">
              <h4 id="ccp-skills-review-h">{CL.skillsReviewHeading}</h4>
              <SkillReviewList rows={rest} client={client} onDone={list.reload} />
            </section>
          )}
        </>
      )}
    </section>
  )
}
