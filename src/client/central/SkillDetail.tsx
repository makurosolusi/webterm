// Detail of one library row: what it is for, the tools it asks for, its instructions, and the human actions
// (on/off switch for an active skill, Edit for your own skill, Duplicate and edit for a built-in one).
import { ActionButton, ActionResult, useAction } from '@/components/ui/action'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useRef, useState } from 'react'
import { CL } from './centralLabels'
import type { CentralControlClient, SkillReviewRow } from './centralControlTypes'
import { createErrorLines } from './skillLibraryModel'

interface Props {
  row: SkillReviewRow
  client: CentralControlClient
  onClose: () => void
  /** The list changed (switch flipped, copy made): reload it. */
  onChanged: () => void
  /** Opens the edit form for this row. */
  onEdit: () => void
  /** Called with the new name after a copy of a built-in skill was saved. */
  onForked: (name: string) => void
  /** A newer version of this name already waits for review, so an edit would be refused. */
  hasOpenDraft: boolean
}

export default function SkillDetail({ row, client, onClose, onChanged, onEdit, onForked, hasOpenDraft }: Props) {
  const { record, description, body } = row
  const [on, setOn] = useState(record.enabled !== false)
  const target = useRef(on)
  const toggle = useAction(async () => { await client.setSkillEnabled(record.name, target.current); setOn(target.current); onChanged() }, { label: CL.skillEnabled, failure: () => CL.skillEnabledFailed })
  const fork = useAction(async () => { const name = await client.forkSkill(record.name); onForked(name) }, { label: CL.skillDuplicate, toast: 'never', failure: (e) => createErrorLines(e)[0] ?? CL.skillDuplicateFailed })
  const active = record.status === 'active'
  const builtin = record.origin === 'builtin'
  return (
    <article className="ccp-card" aria-label={`${record.name} ${record.version} details`}>
      <header>
        <strong>{record.name}</strong> <span>{record.version}</span>
        <span className="ccp-badge">{record.status}</span> <span className="ccp-badge">{record.origin}</span>
        {!on && <span className="ccp-badge">{CL.skillOff}</span>}
        <Button type="button" size="xs" variant="secondary" onClick={onClose}>{CL.skillBack}</Button>
      </header>
      {description && <p>{description}</p>}
      <p>{CL.skillCaps}: {record.caps.length > 0 ? record.caps.join(', ') : CL.skillCapsNone}</p>
      {active && (
        <div>
          <label className="ccp-cap"><Switch checked={on} disabled={toggle.busy} aria-label={CL.skillEnabled} onCheckedChange={(v) => { target.current = v; void toggle.run() }} />{CL.skillEnabled}</label>
          <small role="status">{on ? CL.skillEnabledOn : CL.skillEnabledOff}</small>
          <ActionResult action={toggle} />
        </div>
      )}
      {builtin && <p>{CL.skillBuiltinReadOnly}</p>}
      {body ? <pre className="ccp-diff" tabIndex={0} aria-label={CL.skillInstructions}>{body}</pre> : <p>{CL.skillNoBody}</p>}
      {active && !builtin && <Button type="button" size="sm" disabled={hasOpenDraft} onClick={onEdit}>{CL.skillEdit}</Button>}
      {active && !builtin && hasOpenDraft && <small>{CL.skillEditOpenDraft}</small>}
      {active && builtin && <ActionButton type="button" size="sm" action={fork} busyLabel={CL.skillDuplicating}>{CL.skillDuplicate}</ActionButton>}
      <ActionResult action={fork} />
    </article>
  )
}
