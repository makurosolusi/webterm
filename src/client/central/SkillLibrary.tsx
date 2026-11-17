// Skills tab: a searchable library of every skill (builtin, human, Central), a read-only detail, the
// "New skill" form, and the review actions for rows that wait on a human.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState } from 'react'
import { SKILL_AUDIENCES, type SkillAudience } from '../../server/central/contracts/skill.types'
import { AudienceBadge } from './SkillAudience'
import { useNodeActions } from '../nodeActions'
import SkillAuthorDrafts from './SkillAuthorDrafts'
import { CL } from './centralLabels'
import { SKILLS_OFF, centralControlApi } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { useLoad } from './centralLoad'
import SkillCreateForm from './SkillCreateForm'
import SkillDetail from './SkillDetail'
import SkillReviewList from './SkillReview'
import SkillsOff from './SkillsOff'
import { needsReview, searchRows } from './skillLibraryModel'

const OPEN: readonly string[] = ['proposed', 'evaluated', 'pending_approval']
const keyOf = (r: SkillReviewRow): string => `${r.record.name}@${r.record.version}`

function LibraryRow({ row, selected, onSelect }: { row: SkillReviewRow; selected: boolean; onSelect: () => void }) {
  const { record, description } = row
  return (
    <li className="ccp-skill-row">
      <Button type="button" size="sm" variant="ghost" aria-pressed={selected} aria-label={`${CL.skillView} ${record.name} ${record.version}`} onClick={onSelect}>
        <strong>{record.name}</strong> <span>{record.version}</span>
        <span className="ccp-badge">{record.origin}</span> <AudienceBadge audience={record.audience} /> <span className="ccp-badge">{record.status}</span>
        {record.enabled === false && <span className="ccp-badge">{CL.skillOff}</span>}
      </Button>
      {description && <p>{description}</p>}
    </li>
  )
}

export default function SkillLibrary({ client = centralControlApi }: { client?: CentralControlClient }) {
  const list = useLoad((s) => client.listSkills(s))
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<SkillAudience | null>(null)
  const [editing, setEditing] = useState<SkillReviewRow | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const { openSkillAuthor } = useNodeActions()
  const [authorNode, setAuthorNode] = useState<string | null>(null)
  const off = list.code === SKILLS_OFF
  const rows = list.data ?? []
  const shown = searchRows(rows, query)
  const detail = rows.find((r) => keyOf(r) === selected)
  return (
    <section className="ccp-section" aria-labelledby="ccp-skills-h">
      <h3 id="ccp-skills-h">{CL.skillsLibraryHeading}</h3>
      {off && <SkillsOff onEnabled={list.reload} />}
      {list.error && !off && (
        <div><p role="alert" className="ccp-error">{list.error}</p><Button type="button" size="sm" variant="secondary" onClick={list.reload}>{CL.skillsRetry}</Button></div>
      )}
      {list.loading && !list.data && <p role="status">{CL.loading}</p>}
      {authorNode && !off && <SkillAuthorDrafts key={authorNode} nodeId={authorNode} client={client} onClose={() => setAuthorNode(null)} onChanged={list.reload} />}
      {created && <p role="status" className="ccp-ok">{created}</p>}
      {creating && !off && <SkillCreateForm client={client} initialAudience={creating} onCancel={() => setCreating(null)} onCreated={(name) => { setCreating(null); setCreated(CL.skillCreated(name)); list.reload() }} />}
      {editing && !off && <SkillCreateForm client={client} edit={editing} onCancel={() => setEditing(null)} onCreated={(name) => { setEditing(null); setCreated(CL.skillEditSaved(name)); list.reload() }} />}
      {list.data && rows.length === 0 && <p>{CL.skillsEmpty}</p>}
      {!off && list.data && (
        <>
          {rows.length > 0 && <Input type="search" value={query} aria-label={CL.skillsSearch} placeholder={CL.skillsSearch} autoComplete="off" onChange={(e) => setQuery(e.target.value)} />}
          {rows.length > 0 && shown.length === 0 && <p>{CL.skillsNoMatch}</p>}
          {SKILL_AUDIENCES.map((a) => (
            <section key={a} className="ccp-section" aria-label={CL.skillSectionHeading[a]}>
              <h4>{CL.skillSectionHeading[a]}</h4>
              <p>{CL.skillSectionPurpose[a]}</p>
              {!creating && <Button type="button" size="sm" aria-label={`${CL.skillNew} (${CL.skillAudienceBadge[a]})`} onClick={() => { setCreating(a); setCreated(null) }}>{CL.skillNew}</Button>}
              {a === 'canvas' && openSkillAuthor && <Button type="button" size="sm" variant="secondary" onClick={() => setAuthorNode(openSkillAuthor())}>{CL.skillAuthorWrite}</Button>}
              {shown.every((r) => r.record.audience !== a) && query.trim() === '' && <p>{CL.skillSectionEmpty[a]}</p>}
              <ul aria-label={CL.skillSectionHeading[a]} className="ccp-skill-list">
                {shown.filter((r) => r.record.audience === a).map((r) => <LibraryRow key={keyOf(r)} row={r} selected={keyOf(r) === selected} onSelect={() => setSelected(keyOf(r) === selected ? null : keyOf(r))} />)}
              </ul>
            </section>
          ))}
          {detail && <SkillDetail key={keyOf(detail)} row={detail} client={client} onClose={() => setSelected(null)} onChanged={list.reload} onEdit={() => { setEditing(detail); setCreating(null) }} onAuthor={openSkillAuthor && detail.record.audience === 'canvas' ? () => setAuthorNode(openSkillAuthor(detail.record.name)) : undefined} hasOpenDraft={rows.some((r) => r.record.name === detail.record.name && OPEN.includes(r.record.status))} onForked={(name) => { setSelected(null); setCreated(CL.skillCreated(name)); list.reload() }} />}
          {rows.some(needsReview) && <h4>{CL.skillsReviewHeading}</h4>}
          <SkillReviewList rows={rows.filter(needsReview)} client={client} onDone={list.reload} />
        </>
      )}
    </section>
  )
}
