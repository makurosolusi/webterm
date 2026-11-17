// Skills tab: a searchable library of every skill, a read-only detail, and the review actions for rows that wait on a
// human. Skills are written only by the author agents: each section has "Write with an agent", no form types a skill.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { SKILL_AUDIENCES } from '../../server/central/contracts/skill.types'
import { AudienceBadge } from './SkillAudience'
import type { ChatClient } from '../chat/chatTypes'
import { useNodeActions } from '../nodeActions'
import CentralSkillAuthorButton from './CentralSkillAuthorButton'
import SkillAuthorDrafts, { CentralDraftsPanel } from './SkillAuthorDrafts'
import { CL } from './centralLabels'
import { SKILLS_OFF, centralControlApi } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { useLoad } from './centralLoad'
import SkillDetail from './SkillDetail'
import SkillReviewList from './SkillReview'
import SkillsOff from './SkillsOff'
import { needsReview, searchRows, titleOf } from './skillLibraryModel'
import { centralDraftsOf } from './skillAuthorModel'

const OPEN: readonly string[] = ['proposed', 'evaluated', 'pending_approval']
const keyOf = (r: SkillReviewRow): string => `${r.record.name}@${r.record.version}`

function LibraryRow({ row, selected, onSelect }: { row: SkillReviewRow; selected: boolean; onSelect: () => void }) {
  const { record, description } = row
  return (
    <li className="ccp-skill-row">
      <Button type="button" size="sm" variant="ghost" aria-pressed={selected} aria-label={`${CL.skillView} ${record.name} ${record.version}`} onClick={onSelect}>
        <strong>{titleOf(row)}</strong> <small>{record.name}</small> <span>{record.version}</span>
        <span className="ccp-badge">{record.origin}</span> <AudienceBadge audience={record.audience} /> <span className="ccp-badge">{record.status}</span>
        {record.enabled === false && <span className="ccp-badge">{CL.skillOff}</span>}
      </Button>
      {description && <p>{description}</p>}
    </li>
  )
}

export default function SkillLibrary({ client = centralControlApi, chat }: { client?: CentralControlClient; /** Test seam for the chat API the Central skill author opens its conversation with. */ chat?: Pick<ChatClient, 'createConversation'> }) {
  const list = useLoad((s) => client.listSkills(s))
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const { openSkillAuthor } = useNodeActions()
  const [authorNode, setAuthorNode] = useState<string | null>(null)
  const off = list.code === SKILLS_OFF
  const rows = list.data ?? []
  const shown = searchRows(rows, query)
  const detail = rows.find((r) => keyOf(r) === selected)
  // Central's own drafts are reviewed in their Drafts panel, so the general review list does not repeat them.
  const inDrafts = new Set(centralDraftsOf(rows))
  const hasOpen = (d: SkillReviewRow): boolean => rows.some((r) => r.record.name === d.record.name && OPEN.includes(r.record.status))
  // "Ask the agent ..." of the open detail: a built-in is read only and only offers a variant (the author gets no target, so it cannot touch the built-in).
  const reviseOf = (d: SkillReviewRow) => {
    const { name, origin, audience, status } = d.record
    const blocked = status !== 'active' || hasOpen(d)
    if (origin === 'builtin') return <><small>{CL.skillVariantHint(name)}</small> <CentralSkillAuthorButton key={`variant:${keyOf(d)}`} label={CL.skillAuthorVariant} kind={audience} {...(chat ? { chat } : {})} /></>
    if (audience === 'canvas' && openSkillAuthor) return <Button type="button" size="sm" variant="secondary" disabled={blocked} onClick={() => setAuthorNode(openSkillAuthor(name))}>{CL.skillAuthorRevise}</Button>
    return <CentralSkillAuthorButton key={`author:${keyOf(d)}`} target={name} label={CL.skillAuthorRevise} kind={audience} disabled={blocked} {...(chat ? { chat } : {})} />
  }
  const rest = rows.filter((r) => needsReview(r) && !inDrafts.has(r))
  return (
    <section className="ccp-section" aria-labelledby="ccp-skills-h">
      <h3 id="ccp-skills-h">{CL.skillsLibraryHeading}</h3>
      {off && <SkillsOff onEnabled={list.reload} />}
      {list.error && !off && (
        <div><p role="alert" className="ccp-error">{list.error}</p><Button type="button" size="sm" variant="secondary" onClick={list.reload}>{CL.skillsRetry}</Button></div>
      )}
      {list.loading && !list.data && <p role="status">{CL.loading}</p>}
      {authorNode && !off && <SkillAuthorDrafts key={authorNode} nodeId={authorNode} client={client} onClose={() => setAuthorNode(null)} onChanged={list.reload} />}
      {list.data && rows.length === 0 && <p>{CL.skillsEmpty}</p>}
      {!off && list.data && (
        <>
          {rows.length > 0 && <Input type="search" value={query} aria-label={CL.skillsSearch} placeholder={CL.skillsSearch} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />}
          {rows.length > 0 && shown.length === 0 && <p>{CL.skillsNoMatch}</p>}
          {SKILL_AUDIENCES.map((a) => (
            <section key={a} className="ccp-section" aria-label={CL.skillSectionHeading[a]}>
              <h4>{CL.skillSectionHeading[a]}</h4>
              <p>{CL.skillSectionPurpose[a]}</p>
              {/* Canvas skills open the canvas author node when there is a board; otherwise Central's author chat writes either kind. */}
              {a === 'canvas' && openSkillAuthor
                ? <Button type="button" size="sm" aria-label={`${CL.skillAuthorWrite} (${CL.skillAudienceBadge[a]})`} onClick={() => setAuthorNode(openSkillAuthor())}>{CL.skillAuthorWrite}</Button>
                : <CentralSkillAuthorButton label={CL.skillAuthorWrite} kind={a} primary {...(chat ? { chat } : {})} />}
              {a === 'central' && <CentralDraftsPanel list={list} client={client} />}
              {shown.every((r) => r.record.audience !== a) && query.trim() === '' && <p>{CL.skillSectionEmpty[a]}</p>}
              <ul aria-label={CL.skillSectionHeading[a]} className="ccp-skill-list">
                {shown.filter((r) => r.record.audience === a).map((r) => <LibraryRow key={keyOf(r)} row={r} selected={keyOf(r) === selected} onSelect={() => setSelected(keyOf(r) === selected ? null : keyOf(r))} />)}
              </ul>
            </section>
          ))}
          {detail && <SkillDetail key={keyOf(detail)} row={detail} client={client} onClose={() => setSelected(null)} onChanged={list.reload} revise={reviseOf(detail)} hasOpenDraft={hasOpen(detail)} />}
          {rest.length > 0 && <h4>{CL.skillsReviewHeading}</h4>}
          <SkillReviewList rows={rest} client={client} onDone={list.reload} />
        </>
      )}
    </section>
  )
}
