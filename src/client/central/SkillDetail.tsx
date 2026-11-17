// Detail of one library row: what it is for, the tools it asks for, its instructions, and the human actions
// (on/off switch for an active skill, Edit for your own skill, Duplicate and edit for a built-in one).
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useRef, useState } from 'react'
import { CL } from './centralLabels'
import type { SkillAudience } from '../../server/central/contracts/skill.types'
import { AudienceBadge, AudienceSelect } from './SkillAudience'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { createErrorLines } from './skillLibraryModel'
import { useNodeActions } from '../nodeActions'
import { SN } from '../skillNode.labels'
import { MAX_ATTACHED_SKILLS } from '../../shared/skillPorts'

interface Props {
  row: SkillReviewRow
  client: CentralControlClient
  onClose: () => void
  /** The list changed (switch flipped, copy made): reload it. */
  onChanged: () => void
  /** Opens the edit form for this row. */
  onEdit: () => void
  /** Opens a skill-author chat for this skill; absent when Claude is disabled. */
  onAuthor?: () => void
  /** Called with the new name after a copy of a built-in skill was saved. */
  onForked: (name: string) => void
  /** A newer version of this name already waits for review, so an edit would be refused. */
  hasOpenDraft: boolean
}

export default function SkillDetail({ row, client, onClose, onChanged, onEdit, onAuthor, onForked, hasOpenDraft }: Props) {
  const { record, description, body } = row
  const [on, setOn] = useState(record.enabled !== false)
  const target = useRef(on)
  const toggle = useAction(async () => { await client.setSkillEnabled(record.name, target.current); setOn(target.current); onChanged() }, { label: CL.skillEnabled, failure: () => CL.skillEnabledFailed })
  const [forkAudience, setForkAudience] = useState<SkillAudience>(record.audience)
  const fork = useAction(async () => { const name = await client.forkSkill(record.name, forkAudience); onForked(name) }, { label: CL.skillDuplicate, toast: 'never', failure: (e) => createErrorLines(e)[0] ?? CL.skillDuplicateFailed })
  const active = record.status === 'active'
  // Canvas skills only, and only while active and switched on: a skill node of anything else would be Unavailable at once.
  const { addSkillNode } = useNodeActions()
  const [added, setAdded] = useState<string | null>(null)
  const canAdd = active && on && record.audience === 'canvas'
  const addToCanvas = () => {
    const r = addSkillNode?.({ name: record.name, version: record.version })
    setAdded(r === undefined || r.status === 'no_board' ? SN.addToCanvasNoBoard : r.status === 'attached' ? SN.addedAttached : r.status === 'limit' ? SN.addedLimit(MAX_ATTACHED_SKILLS) : SN.added)
  }
  const builtin = record.origin === 'builtin'
  return (
    <article className="ccp-card" aria-label={`${record.name} ${record.version} details`}>
      <header>
        <strong>{record.name}</strong> <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span> <span className="ccp-badge">{record.origin}</span> <AudienceBadge audience={record.audience} />
        {!on && <span className="ccp-badge">{CL.skillOff}</span>}
        <Button type="button" size="xs" variant="secondary" onClick={onClose}>{CL.skillBack}</Button>
      </header>
      {description && <p>{description}</p>}
      <p><small>{CL.skillAudienceHelp[record.audience]}</small></p>
      <p>{CL.skillCaps}: {record.caps.length > 0 ? record.caps.join(', ') : CL.skillCapsNone}</p>
      {active && (
        <div>
          <label className="ccp-cap"><Switch checked={on} disabled={toggle.busy} aria-label={CL.skillEnabled} onCheckedChange={(v) => { target.current = v; void toggle.run() }} />{CL.skillEnabled}</label>
          <small role="status">{on ? CL.skillEnabledOn : CL.skillEnabledOff}</small>
          <ActionResult action={toggle} />
        </div>
      )}
      {builtin && <p>{CL.skillBuiltinReadOnly}</p>}
      {record.audience === 'canvas' && active && (
        <div>
          <Button type="button" size="sm" variant="secondary" disabled={!canAdd || !addSkillNode} onClick={addToCanvas}>{SN.addToCanvas}</Button>
          {!canAdd && <small> {SN.addToCanvasOnly}</small>}
          {canAdd && !addSkillNode && <small> {SN.addToCanvasNoBoard}</small>}
          {added && <small role="status"> {added}</small>}
        </div>
      )}
      {body ? <pre className="ccp-diff" tabIndex={0} aria-label={CL.skillInstructions}>{body}</pre> : <p>{CL.skillNoBody}</p>}
      {active && !builtin && <Button type="button" size="sm" disabled={hasOpenDraft} onClick={onEdit}>{CL.skillEdit}</Button>}
      {onAuthor && !builtin && <Button type="button" size="sm" variant="secondary" disabled={!active || hasOpenDraft} onClick={onAuthor}>{CL.skillAuthorEdit}</Button>}
      {onAuthor && builtin && <><Button type="button" size="sm" variant="secondary" disabled>{CL.skillAuthorEdit}</Button><small>{CL.skillAuthorBuiltinHint}</small></>}
      {active && !builtin && hasOpenDraft && <small>{CL.skillEditOpenDraft}</small>}
      {active && <AudienceSelect value={forkAudience} onChange={setForkAudience} disabled={fork.busy} />}
      {active && <ActionButton type="button" size="sm" action={fork} busyLabel={CL.skillDuplicating}>{CL.skillDuplicate}</ActionButton>}
      <ActionResult action={fork} />
    </article>
  )
}
