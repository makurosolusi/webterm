// "Drafts from this agent": the open proposals of one skill-author chat node, for the human to review next to the
// conversation. Each card is the normal review card (diff against the active version, lint, typed approval for an
// agent draft, Reject). Edit saves the human's text as a NEW human-origin version, which is then one-click approvable.
// Refreshes when the chat reports a finished turn and on the Refresh button; there is no polling.
import { Button } from '@/components/ui/button'
import { useEffect, useMemo, useRef, useState } from 'react'
import { onSkillAuthorActivity } from '../agentChat/skillAuthor.events'
import { CL } from './centralLabels'
import { SKILLS_OFF } from './centralControlApi'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { useLoad } from './centralLoad'
import { draftsOf } from './skillAuthorModel'
import SkillCreateForm from './SkillCreateForm'
import SkillReviewList from './SkillReview'

interface Props { nodeId: string; client: CentralControlClient; onClose: () => void; /** A draft was approved, rejected or replaced: reload the library. */ onChanged: () => void }

export default function SkillAuthorDrafts({ nodeId, client, onClose, onChanged }: Props) {
  const list = useLoad((s) => client.listSkills(s))
  const [editing, setEditing] = useState<SkillReviewRow | null>(null)
  const reload = list.reload
  useEffect(() => onSkillAuthorActivity(nodeId, reload), [nodeId, reload])
  const drafts = draftsOf(list.data ?? [], nodeId)
  const done = (): void => { list.reload(); onChanged() }
  // An edit is refused while another version is open, so the agent draft is rejected first (once, even when the save is retried).
  const rejected = useRef(false)
  const editClient = useMemo<CentralControlClient>(() => ({
    ...client,
    editSkill: async (name, input) => {
      if (editing && !rejected.current) { await client.rejectSkill(editing.record.name, editing.record.version); rejected.current = true }
      await client.editSkill(name, input)
    },
  }), [client, editing])
  const startEdit = (r: SkillReviewRow): void => { rejected.current = false; setEditing(r) }
  return (
    <section className="ccp-card" aria-label={CL.skillAuthorDrafts}>
      <header>
        <h4>{CL.skillAuthorDrafts}</h4>
        <Button type="button" size="xs" variant="secondary" disabled={list.loading} onClick={list.reload}>{CL.skillAuthorRefresh}</Button>
        <Button type="button" size="xs" variant="secondary" onClick={onClose}>{CL.skillAuthorHide}</Button>
      </header>
      {list.code === SKILLS_OFF && <p>{CL.skillsOff}</p>}
      {list.error && list.code !== SKILLS_OFF && (
        <div><p role="alert" className="ccp-error">{list.error}</p><Button type="button" size="sm" variant="secondary" onClick={list.reload}>{CL.skillsRetry}</Button></div>
      )}
      {list.loading && !list.data && <p role="status">{CL.loading}</p>}
      {list.data && drafts.length === 0 && !editing && <p>{CL.skillAuthorEmpty}</p>}
      {editing && (
        <SkillCreateForm client={editClient} edit={editing} onCancel={() => setEditing(null)} onCreated={() => { setEditing(null); done() }} />
      )}
      {!editing && drafts.map((r) => (
        <div key={`${r.record.name}@${r.record.version}:${r.record.status}`}>
          <SkillReviewList rows={[r]} client={client} onDone={done} />
          <Button type="button" size="sm" variant="secondary" aria-label={`${CL.skillEdit} ${r.record.name} ${r.record.version}`} onClick={() => startEdit(r)}>{CL.skillEdit}</Button>
        </div>
      ))}
    </section>
  )
}
